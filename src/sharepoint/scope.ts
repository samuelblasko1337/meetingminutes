// FILE: src/sharepoint/scope.ts
import type { Graph } from "../graph/client.js";
import type { GraphConfig } from "../config.js";
import type { UserIdentity } from "../auth/userIdentity.js";
import type { DriveItem } from "./driveItem.js";
import { driveItemFullPath } from "./driveItem.js";
import { AppError } from "../utils/errors.js";
import { ensureUserFolders } from "./userFolders.js";

export type Scope = {
  driveId: string;
  siteId: string;
  inputFolderId: string;
  outputFolderId: string;
  inputPrefix: string;  // canonical fullPath of folder
  outputPrefix: string; // canonical fullPath of folder
  baseFolderId?: string;
  basePrefix?: string;
  userFolderId?: string;
  userPrefix?: string;
  userKey?: string;
  userEmail?: string | null;
};

function pathStartsWith(prefix: string, fullPath: string): boolean {
  return fullPath === prefix || fullPath.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

async function ensureDriveInSite(graph: Graph, config: GraphConfig) {
  await graph.request("GET", `/sites/${config.SITE_ID}/drives/${config.DRIVE_ID}`);
}

export async function initScope(graph: Graph, config: GraphConfig): Promise<Scope> {
  const inputFolderId = config.INPUT_FOLDER_ID;
  const outputFolderId = config.OUTPUT_FOLDER_ID;
  if (!inputFolderId || !outputFolderId) {
    throw new AppError(500, "InternalError", "INPUT_FOLDER_ID/OUTPUT_FOLDER_ID required for fixed scope");
  }

  // 1) Ensure drive is within site (enforces SITE_ID + DRIVE_ID pairing)
  // If not, Graph returns 404/403 depending on permissions.
  await ensureDriveInSite(graph, config);

  // 2) Load folder metadata + compute prefixes
  const select = "$select=id,name,eTag,lastModifiedDateTime,size,webUrl,parentReference,file,folder";

  const inputFolder = (await graph.request<DriveItem>(
    "GET",
    `/drives/${config.DRIVE_ID}/items/${inputFolderId}?${select}`
  )) as DriveItem;

  const outputFolder = (await graph.request<DriveItem>(
    "GET",
    `/drives/${config.DRIVE_ID}/items/${outputFolderId}?${select}`
  )) as DriveItem;

  if (!inputFolder.folder) throw new AppError(404, "NotFound", "INPUT_FOLDER_ID is not a folder");
  if (!outputFolder.folder) throw new AppError(404, "NotFound", "OUTPUT_FOLDER_ID is not a folder");

  const inputPath = driveItemFullPath(inputFolder);
  const outputPath = driveItemFullPath(outputFolder);

  if (!inputPath) throw new AppError(404, "NotFound", "Unable to compute input folder path prefix");
  if (!outputPath) throw new AppError(404, "NotFound", "Unable to compute output folder path prefix");

  // Ensure drive binding
  if (inputFolder.parentReference?.driveId && inputFolder.parentReference.driveId !== config.DRIVE_ID) {
    throw new AppError(403, "Forbidden", "INPUT_FOLDER_ID not in configured DRIVE_ID");
  }
  if (outputFolder.parentReference?.driveId && outputFolder.parentReference.driveId !== config.DRIVE_ID) {
    throw new AppError(403, "Forbidden", "OUTPUT_FOLDER_ID not in configured DRIVE_ID");
  }

  return {
    driveId: config.DRIVE_ID,
    siteId: config.SITE_ID,
    inputFolderId,
    outputFolderId,
    inputPrefix: inputPath,
    outputPrefix: outputPath
  };
}

export async function initUserScope(
  graph: Graph,
  config: GraphConfig,
  user: UserIdentity
): Promise<Scope> {
  await ensureDriveInSite(graph, config);

  const folders = await ensureUserFolders(graph, config.DRIVE_ID, config.BASE_FOLDER_NAME, user.userKey);
  const basePrefix = driveItemFullPath(folders.baseFolder);
  const userPrefix = driveItemFullPath(folders.userFolder);
  const inputPrefix = driveItemFullPath(folders.inputFolder);
  const outputPrefix = driveItemFullPath(folders.outputFolder);

  if (!basePrefix || !userPrefix || !inputPrefix || !outputPrefix) {
    throw new AppError(500, "InternalError", "Unable to compute folder path prefixes");
  }
  if (!pathStartsWith(basePrefix, userPrefix)) {
    throw new AppError(403, "Forbidden", "User folder not within BASE_FOLDER");
  }
  if (!pathStartsWith(userPrefix, inputPrefix)) {
    throw new AppError(403, "Forbidden", "Input folder not within user folder");
  }
  if (!pathStartsWith(userPrefix, outputPrefix)) {
    throw new AppError(403, "Forbidden", "Output folder not within user folder");
  }

  return {
    driveId: config.DRIVE_ID,
    siteId: config.SITE_ID,
    baseFolderId: folders.baseFolder.id,
    basePrefix,
    userFolderId: folders.userFolder.id,
    userPrefix,
    inputFolderId: folders.inputFolder.id,
    outputFolderId: folders.outputFolder.id,
    inputPrefix,
    outputPrefix,
    userKey: user.userKey,
    userEmail: user.email ?? user.upn ?? null
  };
}

export async function fetchAndValidateDriveItem(
  graph: Graph,
  scope: Scope,
  id: string,
  mode: "download" | "any"
): Promise<{ item: DriveItem; fullPath: string }> {
  const select = "$select=id,name,eTag,lastModifiedDateTime,size,webUrl,parentReference,file,folder";
  const item = (await graph.request<DriveItem>(
    "GET",
    `/drives/${scope.driveId}/items/${id}?${select}`
  )) as DriveItem;

  const driveId = item.parentReference?.driveId;
  if (driveId && driveId !== scope.driveId) {
    throw new AppError(403, "Forbidden", "Item not in configured DRIVE_ID", { requestedId: id });
  }

  const fullPath = driveItemFullPath(item);
  if (!fullPath) throw new AppError(403, "Forbidden", "Unable to compute item path", { requestedId: id });

  if (scope.basePrefix && !pathStartsWith(scope.basePrefix, fullPath)) {
    throw new AppError(403, "Forbidden", "Item not in BASE_FOLDER subtree", { requestedId: id });
  }

  if (mode === "download") {
    if (!pathStartsWith(scope.inputPrefix, fullPath)) {
      throw new AppError(403, "Forbidden", "Item not in INPUT_FOLDER subtree", { requestedId: id });
    }
  }

  return { item, fullPath };
}

export function assertUploadDestinationIsFixed(scope: Scope, destinationFolderId: string) {
  if (destinationFolderId !== scope.outputFolderId) {
    throw new AppError(403, "Forbidden", "Upload destination must be OUTPUT_FOLDER_ID");
  }
}

export function validateItemIsWithinInput(scope: Scope, fullPath: string, id: string) {
  if (!(fullPath === scope.inputPrefix || fullPath.startsWith(`${scope.inputPrefix}/`))) {
    throw new AppError(403, "Forbidden", "Item not in INPUT_FOLDER subtree", { requestedId: id });
  }
}

export function validateItemIsWithinOutput(scope: Scope, fullPath: string) {
  if (!(fullPath === scope.outputPrefix || fullPath.startsWith(`${scope.outputPrefix}/`))) {
    throw new AppError(403, "Forbidden", "Item not in OUTPUT_FOLDER subtree");
  }
}
