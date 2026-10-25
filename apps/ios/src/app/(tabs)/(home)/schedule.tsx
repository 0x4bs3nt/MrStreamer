import { useFixedTabBar } from "../../../tab-bar.ts";
import { ScheduleScreen } from "../../../guide-screen.tsx";

export default function Screen() {
  useFixedTabBar(true);
  return <ScheduleScreen origin="home" />;
}
