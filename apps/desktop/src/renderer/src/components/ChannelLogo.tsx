import { useState } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { cn } from "../lib/utils.ts";

/**
 * The provider's logo, or two letters on a tile tinted from the channel name when there is no
 * logo or it fails to load. Size it with `className`.
 */
export function ChannelLogo({
  channel,
  className,
  plain = false,
}: {
  channel: LiveChannel;
  className?: string;
  /** Initials without their own tile, for places that already tint the background. */
  plain?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const box = cn("h-8 w-12 flex-none", className);
  if (channel.logoUrl && !failed) {
    return (
      <img
        src={channel.logoUrl}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={cn(box, "object-contain")}
      />
    );
  }
  const hue = hueOf(channel.title);
  if (plain) {
    return (
      <span
        className={cn(box, "grid place-items-center font-bold tracking-wide")}
        style={{ color: `hsl(${hue} 55% 78%)` }}
      >
        {initials(channel.title)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        box,
        "grid place-items-center rounded-lg text-[0.625rem] font-bold tracking-wide",
      )}
      style={{ background: `hsl(${hue} 32% 17%)`, color: `hsl(${hue} 55% 78%)` }}
    >
      {initials(channel.title)}
    </span>
  );
}

/** Two letters for a channel without a logo: its first two words', or its first word's two. */
export function initials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first = title, second] = words;
  return (second ? `${first[0] ?? ""}${second[0] ?? ""}` : first.slice(0, 2)).toUpperCase();
}

/** A stable hue for a name, used to tint tiles when there is no artwork. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}
