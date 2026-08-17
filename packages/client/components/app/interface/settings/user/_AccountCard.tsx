import { Trans } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { Avatar, OverflowingText, Ripple, typography } from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/outlined/arrow_back.svg?component-solid";

import { css } from "styled-system/css";
import { useSettingsNavigation } from "../Settings";
import {
  SidebarButton,
  SidebarButtonContent,
  SidebarButtonTitle,
} from "../_layout/SidebarButton";

/**
 * Account Card — the "signed in as" header above the settings list.
 *
 * Still a shortcut to My Account, but it no longer claims the selected state:
 * My Account is a visible row in the Account section now, and that row is
 * what highlights. Two highlighted rows for one page read as two pages.
 */
export function AccountCard() {
  const client = useClient();
  const { navigate } = useSettingsNavigation();

  return (
    <SidebarButton onClick={() => navigate("account")}>
      <Ripple />
      <SidebarButtonTitle>
        <Avatar size={36} src={client().user!.animatedAvatarURL} />
        <SidebarButtonContent>
          <OverflowingText
            class={typography({ class: "label", size: "small" })}
          >
            {client().user!.displayName}
          </OverflowingText>
          <OverflowingText>
            {client().user!.username}#{client().user!.discriminator}
          </OverflowingText>
        </SidebarButtonContent>
      </SidebarButtonTitle>
      {/*<SidebarButtonIcon>
        <MdError {...iconSize(20)} fill={theme!.colour("primary")} />
      </SidebarButtonIcon>*/}
    </SidebarButton>
  );
}

export function BackCard(props: { onClose?: () => void }) {
  return (
    <SidebarButton
      class={"back " + mobileOnly}
      onClick={props.onClose}
      noDrawer
    >
      <Ripple />
      <SidebarButtonTitle>
        <MdArrowBack />
        <SidebarButtonContent>
          <Trans>Back</Trans>
        </SidebarButtonContent>
      </SidebarButtonTitle>
    </SidebarButton>
  );
}

const mobileOnly = css({
  display: "none",
  _tablet: { display: "flex" },
});
