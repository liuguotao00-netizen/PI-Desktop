import { parseAllowedExternalUrl } from "../safe-open-external";

export type BackgroundHostApiOptions = {
  pluginId: string;
  assertPermission: (permission: string) => void;
  openExternal: (url: string) => Promise<void>;
  audit?: (entry: Record<string, unknown>) => void;
  refuseAudio: (api: string) => Promise<never>;
  busPublish: (topic: string, payload?: unknown) => Promise<unknown>;
  busSubscribe: (pattern: string) => Promise<{ subscriptionId: string; pattern: string }>;
  busUnsubscribe: (subscriptionId: string) => Promise<{ ok: true }>;
};

function apiError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Shell, unavailable audio and the plugin event bus. */
export function createBackgroundHostApi(options: BackgroundHostApiOptions) {
  return {
    shell: {
      openExternal: async (url: string) => {
        options.assertPermission("shell.openExternal");
        const allowed = parseAllowedExternalUrl(url);
        if (!allowed) throw apiError("INVALID_ARGUMENT", "only http(s)/mailto URLs allowed");
        await options.openExternal(allowed);
        options.audit?.({ pluginId: options.pluginId, api: "shell.openExternal", ok: true, ts: Date.now(), url });
      },
    },
    audio: {
      getInputDevices: async () => options.refuseAudio("audio.getInputDevices"),
      openInput: async () => options.refuseAudio("audio.openInput"),
      closeInput: async () => options.refuseAudio("audio.closeInput"),
      getCaptureState: async () => options.refuseAudio("audio.getCaptureState"),
      onInputFrame: async () => options.refuseAudio("audio.onInputFrame"),
      offInputFrame: async () => options.refuseAudio("audio.offInputFrame"),
      openOutput: async () => options.refuseAudio("audio.openOutput"),
      writeOutput: async () => options.refuseAudio("audio.writeOutput"),
      stopOutput: async () => options.refuseAudio("audio.stopOutput"),
      closeOutput: async () => options.refuseAudio("audio.closeOutput"),
    },
    bus: {
      publish: async (topic: string, payload?: unknown) => options.busPublish(topic, payload),
      subscribe: async (pattern: string) => options.busSubscribe(pattern),
      unsubscribe: async (subscriptionId: string) => options.busUnsubscribe(subscriptionId),
    },
  };
}
