import type { API } from "stoat.js";

/**
 * Presence values we render.
 *
 * `stoat-api` is a published package, so its `Presence` union still only knows
 * the five upstream presences; the two Sloga-only ones are added here. Values
 * coming off `User.presence` are typed as the narrow union but may carry these
 * at runtime.
 */
export type PresenceValue =
  | API.Presence
  | "LookingForGroup"
  | "LookingForMore";

export type Props = {
  /**
   * User we are dealing with
   * @default Invisible
   */
  status?: PresenceValue;
};

/**
 * Readable label for a presence, for the places that show it as text rather
 * than as a dot. Anything unrecognised (including no presence at all) reads as
 * offline.
 */
export function presenceLabel(presence?: string) {
  switch (presence) {
    case "Online":
      return "Online";
    case "Idle":
      return "Idle";
    case "Focus":
      return "Focus";
    case "Busy":
      return "Do not disturb";
    case "LookingForGroup":
      return "Looking for group";
    case "LookingForMore":
      return "Looking for more";
    default:
      return "Offline";
  }
}

/**
 * Overlays user status in current SVG
 */
const UserStatusGraphic = (props: Props) => {
  /**
   * Convert status to lower case
   */
  const statusLowercase = () => props.status?.toLowerCase() ?? "invisible";

  return (
    <circle
      cx="27"
      cy="27"
      r="5"
      fill={`var(--brand-presence-${statusLowercase()})`}
      mask={`url(#accessible-status-${statusLowercase()})`}
    />
  );
};

/**
 * Stand-alone user status element
 */
export function UserStatus(props: Props & { size: string }) {
  return (
    <svg viewBox="22 22 10 10" height={props.size}>
      <UserStatusGraphic {...props} />
    </svg>
  );
}

UserStatus.Graphic = UserStatusGraphic;
