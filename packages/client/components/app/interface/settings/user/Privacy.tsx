import { createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { API } from "stoat.js";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  Checkbox,
  Column,
  FloatingSelect,
  MenuItem,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Privacy settings page — who can see what about you.
 *
 * Collects the "visible to others" switches that used to be scattered:
 * profile visibility lived inside the profile edit form (saved with the
 * avatar and bio) and game-activity sharing sat between the per-server
 * identity list and the avatar picker. Both are about audience, not about
 * what your profile says, so they read better next to each other and next
 * to Streamer Mode / Encryption in the sidebar.
 */
export function PrivacySettings() {
  return (
    <Column gap="lg">
      <ProfileVisibility />
      <ActivitySharing />
    </Column>
  );
}

/**
 * Who can see the profile bio, banner and connections. Saves on change —
 * unlike the profile form there is nothing else to batch it with.
 */
function ProfileVisibility() {
  const client = useClient();
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const [saving, setSaving] = createSignal(false);

  async function save(value: string) {
    const user = client().user;
    if (!user || saving()) return;
    if (value !== "Everyone" && value !== "Friends") return;
    if (value === user.profileVisibility) return;

    setSaving(true);
    try {
      // `profile_visibility` is additive; stoat-api 0.13.5 predates it
      await user.edit({
        remove: [],
        profile_visibility: value,
      } as API.DataEditUser & { profile_visibility: string });
    } catch {
      snackbar.show({
        message: t`Could not update profile visibility, try again.`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Column>
      <Text class="label">
        <Trans>Profile visibility</Trans>
      </Text>
      <Text class="_status" size="small">
        <Trans>
          Choose who can see your bio, banner, and connections. People you share
          a server or group with can always see your name and avatar.
        </Trans>
      </Text>
      <FloatingSelect
        label={t`Profile visibility`}
        // Bound to the live user object: `edit()` hydrates the response
        // back into it, so a failed save simply leaves the old value showing.
        value={client().user?.profileVisibility}
        onChange={(event) => void save(event.currentTarget.value ?? "")}
      >
        <MenuItem value="Everyone">
          <Trans>Everyone</Trans>
        </MenuItem>
        <MenuItem value="Friends">
          <Trans>Friends only</Trans>
        </MenuItem>
      </FloatingSelect>
    </Column>
  );
}

/**
 * Game-activity sharing (desktop shells only publish it, so the copy says so
 * rather than the row hiding on other platforms — the setting itself syncs).
 */
function ActivitySharing() {
  const state = useState();

  return (
    <CategoryButton.Group>
      <CategoryButton
        action={
          <Checkbox checked={state.settings.getValue("activity:share")} />
        }
        onClick={() =>
          state.settings.setValue(
            "activity:share",
            !state.settings.getValue("activity:share"),
          )
        }
        icon={<Symbol>sports_esports</Symbol>}
        description={
          <Trans>
            Show friends what game you are playing (desktop app only).
          </Trans>
        }
      >
        <Trans>Share Game Activity</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}
