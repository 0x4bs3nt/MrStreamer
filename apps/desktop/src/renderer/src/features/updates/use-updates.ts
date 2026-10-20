import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { IpcMethod } from "@mrstreamer/contracts/ipc";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import type { Channel } from "@mrstreamer/contracts/version";
import { useUi } from "../../app/ui-store.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";

type StatusMethod = Extract<IpcMethod, "updates.check" | "updates.download">;

/**
 * The update status and the actions on it, shared by the top bar's notice and Settings: one
 * service state, whichever the viewer uses. Every action answers with the new status.
 */
export function useUpdates() {
  const client = useQueryClient();
  const status = useQuery(queries.updates());
  const store = (next: UpdateStatus) => client.setQueryData(queries.updates().queryKey, next);
  const action = useMutation({
    mutationFn: (method: StatusMethod) => call(method),
    onSuccess: store,
  });
  const changingChannel = useRef(false);
  const setChannel = useMutation({
    mutationFn: (channel: Channel) => call("updates.setChannel", { channel }),
    onSuccess: store,
    onSettled: () => {
      changingChannel.current = false;
    },
  });
  return {
    status: status.data,
    statusRead: status,
    channelChange: setChannel,
    actionState: action,
    check: () => action.mutate("updates.check"),
    download: () => action.mutate("updates.download"),
    setChannel: (channel: Channel) => {
      if (changingChannel.current || setChannel.isPending) return;
      changingChannel.current = true;
      setChannel.mutate(channel);
    },
    cancel: () => void call("updates.cancel").catch(() => {}),
    dismiss: (version: string) => void call("updates.dismiss", { version }).then(store, () => {}),
    /** Opens the app's page in the Microsoft Store, which updates a copy it installed. */
    openStore: () => void call("updates.openStore").catch(() => {}),
    /**
     * Installs and restarts. The call only settles when the app is still running, because the
     * release was refused or the install couldn't start; Settings then shows why.
     */
    restart: () => {
      const showSettings = () =>
        useUi.setState({ settings: "updates", settingsTarget: "update-check", updateDialog: null });
      call("updates.restart").then(showSettings, showSettings);
    },
  };
}
