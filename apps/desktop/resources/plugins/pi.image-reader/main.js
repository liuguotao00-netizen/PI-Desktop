const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function mimeFromPath(file) {
  const ext = String(file).toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return null;
}

async function readImage(args) {
  const path = args && typeof args.path === "string" ? args.path.trim() : "";
  if (!path) throw new Error("read_image requires a non-empty path");
  const mime = mimeFromPath(path);
  if (!mime) throw new Error("read_image supports png, jpg, jpeg, webp and gif only");
  const stat = await pi.fs.stat(path);
  if (!stat || stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`read_image refuses files over ${MAX_IMAGE_BYTES} bytes`);
  }
  const preview = await pi.fs.readPreview(path);
  if (preview.kind !== "image" || typeof preview.dataUrl !== "string") {
    throw new Error(`read_image could not decode ${path}`);
  }
  const match = /^data:([^;]+);base64,(.*)$/s.exec(preview.dataUrl);
  if (!match) throw new Error("read_image received an invalid data URL");
  return [
    { type: "text", text: `Read image ${path} [${mime}, ${stat.size} bytes]. The image is attached as a visual block.` },
    { type: "image", mimeType: match[1] || mime, data: match[2] },
  ];
}

export async function onLoad() {
  await pi.agent.registerTool({
    name: "read_image",
    description: "Read ONE local image (png/jpg/jpeg/webp/gif, <=10MB) inside the workspace and attach it to the conversation as a visual input block. Use when the user references a screenshot, mockup or photo by path.",
    risk: "low",
    planSafeActions: ["read_image"],
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Image path, absolute or workspace-relative" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: readImage,
  });
}

export async function onUnload() {
  await pi.agent.unregisterTool("read_image");
}

