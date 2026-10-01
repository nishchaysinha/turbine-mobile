export type UnlistenFn = () => void;
export async function listen(): Promise<UnlistenFn> {
  return () => {};
}
export function getCurrentWebviewWindow() {
  return { listen, once: listen, emit: async () => {} };
}
