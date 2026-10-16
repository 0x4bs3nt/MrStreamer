import { DownloadsScreen } from "../downloads-screen.tsx";

/**
 * Downloads with no provider saved, pushed from Connect: the copies still play from the phone.
 * The same list as Home's Downloads, outside the tabs, which need a provider.
 */
export default function OfflineDownloads() {
  return <DownloadsScreen />;
}
