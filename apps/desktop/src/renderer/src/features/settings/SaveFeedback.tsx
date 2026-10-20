import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";

/** Retry feedback can disappear on either pending or success. Keep its keyboard position at the
 * associated control before starting the action, rather than letting Chromium focus body. */
export function focusSettingControl(button: HTMLButtonElement): void {
  if (document.activeElement !== button) return;
  const selector = "input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]";
  const previous = button.parentElement?.previousElementSibling;
  const control = previous?.matches(selector) ? previous : previous?.querySelector(selector);
  const settings = button.closest('[data-view="settings"]');
  const fallback =
    settings?.querySelector('nav button[aria-current="page"]') ??
    settings?.querySelector('nav input[type="search"]');
  if (control instanceof HTMLElement) control.focus();
  else if (fallback instanceof HTMLElement) fallback.focus();
}

/** Feedback stays beside the action that failed. Retrying sends the same intended value. */
export function SaveFeedback({
  pending,
  error,
  retry,
  retryDisabled = false,
}: {
  pending: boolean;
  error: unknown;
  retry: () => void;
  retryDisabled?: boolean;
}) {
  if (pending)
    return (
      <p role="status" className="py-2 text-sm">
        {t("Saving…")}
      </p>
    );
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 py-2 text-sm">
      <span>{describeError(appError(error))}</span>
      <Button
        size="sm"
        variant="ghost"
        aria-disabled={retryDisabled}
        onClick={(event) => {
          if (pending || retryDisabled) return;
          focusSettingControl(event.currentTarget);
          retry();
        }}
      >
        {t("Try again")}
      </Button>
    </div>
  );
}
