// FILE: src/sharepoint/driveItem.ts
export type DriveItem = {
  id: string;
  name: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  size?: number;
  webUrl?: string;
  parentReference?: {
    driveId?: string;
    path?: string;
  };
  file?: {
    mimeType?: string;
  };
  folder?: {
    childCount?: number;
  };
};

export function driveItemFullPath(item: DriveItem): string | null {
  const parentPath = item.parentReference?.path;
  const name = item.name;
  if (!parentPath || !name) return null;
  return `${parentPath}/${name}`;
}
