import type { Graph } from "../graph/client.js";
import type { DriveItem } from "./driveItem.js";
import { encodePathSegment } from "../utils/filename.js";
import { AppError } from "../utils/errors.js";

const SELECT =
  "$select=id,name,eTag,lastModifiedDateTime,size,webUrl,parentReference,file,folder";

async function getByPath(graph: Graph, url: string): Promise<DriveItem | null> {
  const res = await graph.requestRaw("GET", url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new AppError(res.status, "GraphError", "Graph lookup failed", { status: res.status, url });
  }
  return (await res.json()) as DriveItem;
}

async function getFolderUnderRoot(graph: Graph, driveId: string, name: string): Promise<DriveItem | null> {
  const url = `/drives/${driveId}/root:/${encodePathSegment(name)}?${SELECT}`;
  return getByPath(graph, url);
}

async function getFolderUnderItem(
  graph: Graph,
  driveId: string,
  parentId: string,
  name: string
): Promise<DriveItem | null> {
  const url = `/drives/${driveId}/items/${parentId}:/${encodePathSegment(name)}?${SELECT}`;
  return getByPath(graph, url);
}

async function createFolderUnderRoot(graph: Graph, driveId: string, name: string): Promise<DriveItem> {
  const res = await graph.requestRaw("POST", `/drives/${driveId}/root/children`, {
    name,
    folder: {},
    "@microsoft.graph.conflictBehavior": "fail"
  });
  if (res.status === 409) {
    const existing = await getFolderUnderRoot(graph, driveId, name);
    if (existing) return existing;
  }
  if (!res.ok) {
    throw new AppError(res.status, "GraphError", "Create folder failed", { status: res.status, name });
  }
  return (await res.json()) as DriveItem;
}

async function createFolderUnderItem(
  graph: Graph,
  driveId: string,
  parentId: string,
  name: string
): Promise<DriveItem> {
  const res = await graph.requestRaw("POST", `/drives/${driveId}/items/${parentId}/children`, {
    name,
    folder: {},
    "@microsoft.graph.conflictBehavior": "fail"
  });
  if (res.status === 409) {
    const existing = await getFolderUnderItem(graph, driveId, parentId, name);
    if (existing) return existing;
  }
  if (!res.ok) {
    throw new AppError(res.status, "GraphError", "Create folder failed", { status: res.status, name });
  }
  return (await res.json()) as DriveItem;
}

function assertIsFolder(item: DriveItem, label: string) {
  if (!item.folder) {
    throw new AppError(409, "Conflict", `${label} exists but is not a folder`, {
      id: item.id,
      name: item.name
    });
  }
}

export async function ensureUserFolders(
  graph: Graph,
  driveId: string,
  baseFolderName: string,
  userKey: string
): Promise<{
  baseFolder: DriveItem;
  userFolder: DriveItem;
  inputFolder: DriveItem;
  outputFolder: DriveItem;
}> {
  const baseFolder =
    (await getFolderUnderRoot(graph, driveId, baseFolderName)) ??
    (await createFolderUnderRoot(graph, driveId, baseFolderName));
  assertIsFolder(baseFolder, "base folder");

  const userFolder =
    (await getFolderUnderItem(graph, driveId, baseFolder.id, userKey)) ??
    (await createFolderUnderItem(graph, driveId, baseFolder.id, userKey));
  assertIsFolder(userFolder, "user folder");

  const inputFolder =
    (await getFolderUnderItem(graph, driveId, userFolder.id, "input")) ??
    (await createFolderUnderItem(graph, driveId, userFolder.id, "input"));
  assertIsFolder(inputFolder, "input folder");

  const outputFolder =
    (await getFolderUnderItem(graph, driveId, userFolder.id, "output")) ??
    (await createFolderUnderItem(graph, driveId, userFolder.id, "output"));
  assertIsFolder(outputFolder, "output folder");

  return { baseFolder, userFolder, inputFolder, outputFolder };
}
