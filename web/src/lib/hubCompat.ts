// What this hub can do, from what it reports at sign-in (GET /api/auth -> hub {version, features}). Hubs before 0.3.5 report nothing, which is itself the answer.
export type HubInfo = { version: string; features: string[] } | null | undefined;
export const NEEDS: Record<string, string> = { agentActivity: 'previews and times on the agent list', media: 'pictures, videos and files from agents', screenErrors: 'clear messages when a computer view cannot open', mediaTags: 'media cards for tool-made files' };
/** The features this app uses that the hub lacks. `null` = the hub reports no feature list (older than 0.3.5), so assume all are missing. */
export function missingFeatures(hub: HubInfo): string[] | null {
  if (!hub || !Array.isArray(hub.features)) return null;
  return Object.keys(NEEDS).filter((f) => !hub.features.includes(f));
}
export const hubIsOld = (hub: HubInfo) => { const m = missingFeatures(hub); return m === null || m.length > 0; };
