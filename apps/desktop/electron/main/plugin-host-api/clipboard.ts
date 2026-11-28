export type ClipboardHostApiOptions = {
  pluginId: string;
  assertRead: () => void;
  assertWrite: () => void;
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  readHistory: () => Promise<unknown[]>;
  audit?: (entry: Record<string, unknown>) => void;
};

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createClipboardHostApi(options: ClipboardHostApiOptions) {
  return {
    readText: async () => {
      options.assertRead();
      const text = await options.readText();
      options.audit?.({ pluginId: options.pluginId, api: "clipboard.readText", ok: true, ts: Date.now() });
      return text;
    },
    writeText: async (text: string) => {
      options.assertWrite();
      await options.writeText(text);
      options.audit?.({ pluginId: options.pluginId, api: "clipboard.writeText", ok: true, ts: Date.now() });
    },
    getHistory: async () => {
      options.assertRead();
      try {
        const history = await options.readHistory();
        options.audit?.({ pluginId: options.pluginId, api: "clipboard.getHistory", ok: true, entryCount: history.length, ts: Date.now() });
        return history;
      } catch (error) {
        options.audit?.({
          pluginId: options.pluginId,
          api: "clipboard.getHistory",
          ok: false,
          errorCode: (error as { code?: string }).code ?? "INTERNAL",
          ts: Date.now(),
        });
        throw error;
      }
    },
  };
}
