import path from "node:path";
import type pino from "pino";

import type { LocalConfig } from "../config.js";
import type { Graph } from "../graph/client.js";
import type { Scope } from "../sharepoint/scope.js";
import { createLocalGraph } from "./localGraph.js";

export const LOCAL_SITE_ID = "local_site" as const;
export const LOCAL_DRIVE_ID = "local_drive" as const;
export const LOCAL_INPUT_FOLDER_ID = "local_input" as const;
export const LOCAL_OUTPUT_FOLDER_ID = "local_output" as const;

export async function initLocalGraphAndScope(config: LocalConfig, log: pino.Logger): Promise<{ graph: Graph; scope: Scope }> {
  const inputDirAbs = path.resolve(config.LOCAL_INPUT_DIR);
  const outputDirAbs = path.resolve(config.LOCAL_OUTPUT_DIR);
  const inputFolderName = path.basename(inputDirAbs).replace(/\\/g, "/");
  const outputFolderName = path.basename(outputDirAbs).replace(/\\/g, "/");

  const scope: Scope = {
    siteId: LOCAL_SITE_ID,
    driveId: LOCAL_DRIVE_ID,
    inputFolderId: LOCAL_INPUT_FOLDER_ID,
    outputFolderId: LOCAL_OUTPUT_FOLDER_ID,
    inputPrefix: `/drives/${LOCAL_DRIVE_ID}/root:/${inputFolderName}`,
    outputPrefix: `/drives/${LOCAL_DRIVE_ID}/root:/${outputFolderName}`
  };

  const graph = await createLocalGraph(
    {
      driveId: LOCAL_DRIVE_ID,
      siteId: LOCAL_SITE_ID,
      inputFolderId: LOCAL_INPUT_FOLDER_ID,
      outputFolderId: LOCAL_OUTPUT_FOLDER_ID,
      inputDirAbs,
      outputDirAbs,
      inputFolderName,
      outputFolderName
    },
    log
  );

  log.info({ msg: "Local mode enabled", inputDirAbs, outputDirAbs });

  return { graph, scope };
}
