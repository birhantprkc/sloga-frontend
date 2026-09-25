import { Show } from "solid-js";

import { User } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useTime } from "@revolt/i18n";
import {
  Avatar,
  CategoryButton,
  IconButton,
  iconSize,
  isSlogaStaff,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";

import MdCakeFill from "@material-design-icons/svg/filled/cake.svg?component-solid";
import MdEdit from "@material-design-icons/svg/outlined/edit.svg?component-solid";

export function UserSummary(props: {
  user: User;
  showBadges?: boolean;
  bannerUrl?: string;
  onEdit?: () => void;
}) {
  const dayjs = useTime();
  const bannerStyle = () =>
    props.bannerUrl
      ? {
          "background-image": `linear-gradient(color-mix(in srgb, var(--md-sys-color-surface-container-low) 70%, transparent), color-mix(in srgb, var(--md-sys-color-surface-container-low) 70%, transparent)), url("${props.bannerUrl}")`,
          color: "black",
        }
      : {
          background: `var(--md-sys-color-primary-container)`,
          color: "var(--md-sys-color-on-primary)",
        };

  return (
    <CategoryButton.Group>
      <AccountBox style={bannerStyle()}>
        <ProfileDetails>
          <Avatar src={props.user.animatedAvatarURL} size={58} />
          <Username>
            <span>
              <DisplayName
                user={props.user}
                name={props.user.displayName}
                brand={isSlogaStaff(props.user)}
              />
            </span>
            <span>
              {props.user.username}#{props.user.discriminator}
            </span>
          </Username>
          <Show when={props.onEdit}>
            <IconButton variant="filled" shape="square" onPress={props.onEdit}>
              <MdEdit />
            </IconButton>
          </Show>
        </ProfileDetails>
        <Show when={props.showBadges}>
          <BottomBar>
            <DummyPadding />
            {/* <ProfileBadges>
              <MdDraw {...iconSize(20)} />
              <MdDraw {...iconSize(20)} />
              <MdDraw {...iconSize(20)} />
            </ProfileBadges> */}
            <ProfileBadges>
              <span
                class={badgeHitArea}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    // L and LT are the localized tokens the Language settings write
                    // to (Locale.setDateFormat / setTimeFormat), so this respects the
                    // chosen date and time format. The literals are still
                    // untranslated - todo.
                    content: dayjs(props.user.createdAt).format(
                      "[Account created] L [at] LT",
                    ),
                  },
                }}
              >
                <MdCakeFill {...iconSize(14)} />
              </span>
            </ProfileBadges>
          </BottomBar>
        </Show>
      </AccountBox>
    </CategoryButton.Group>
  );
}

const AccountBox = styled("div", {
  base: {
    display: "flex",
    padding: "var(--gap-lg)",
    flexDirection: "column",

    backgroundSize: "cover",
    backgroundPosition: "center",
  },
});

const ProfileDetails = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-lg)",
    alignItems: "center",
  },
});

const Username = styled("div", {
  base: {
    flexGrow: 1,

    display: "flex",
    flexDirection: "column",

    color: "var(--md-sys-color-on-secondary-container)",

    // Display Name (direct children only, so the name's own nested spans,
    // e.g. brand letters, don't pick up these sizes)
    "& > :nth-child(1)": {
      fontSize: "18px",
      fontWeight: 600,
    },

    // Username#Discrim
    "& > :nth-child(2)": {
      fontSize: "14px",
      fontWeight: 400,
    },
  },
});

const BottomBar = styled("div", {
  base: {
    display: "flex",
  },
});

const DummyPadding = styled("div", {
  base: {
    flexShrink: 0,
    // Matches with avatar size
    width: "58px",
    // Matches with ProfileDetails
    marginInlineEnd: "var(--gap-lg)",
  },
});

/**
 * Touch target for a badge.
 *
 * The badge icon is 14px, far below a usable tap target, so tapping it on a
 * phone mostly misses and the tooltip never opens. The hit area is grown with
 * a centred pseudo-element rather than padding, so the badge pill keeps its
 * current size and nothing in the layout moves.
 *
 * Note: at 44px these overlap once there is more than one badge (the row uses
 * gap-sm). Revisit the spacing when the commented-out badges above land.
 */
const badgeHitArea = css({
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",

  _before: {
    content: '""',
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "44px",
    height: "44px",
    transform: "translate(-50%, -50%)",
  },
});

const ProfileBadges = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    width: "fit-content",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",

    fill: "var(--md-sys-color-on-secondary)",
    background: "var(--md-sys-color-secondary)",
  },
});
