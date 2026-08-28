import { createFormControl, createFormGroup } from "solid-forms";
import { Match, Show, Switch, createEffect, createSignal, on } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { API, User } from "stoat.js";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  CategoryButton,
  CircularProgress,
  Column,
  Form2,
  Row,
  Text,
} from "@revolt/ui";

import MdBadge from "@material-design-icons/svg/filled/badge.svg?component-solid";

import { useSettingsNavigation } from "../../Settings";

interface Props {
  user: User;
}

export function UserProfileEditor(props: Props) {
  const { t } = useLingui();
  const err = useError();
  const client = useClient();
  const queryClient = useQueryClient();

  const profile = useQuery(() => ({
    queryKey: ["profile", props.user.id],
    queryFn: () => props.user.fetchProfile(),
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  }));

  const { navigate } = useSettingsNavigation();

  /* eslint-disable solid/reactivity */
  const editGroup = createFormGroup({
    displayName: createFormControl(props.user.displayName),
    pronouns: createFormControl(props.user.pronouns ?? ""),
    // username: createFormControl(props.user.username),
    avatar: createFormControl<string | File[] | null>(
      props.user.animatedAvatarURL,
    ),
    banner: createFormControl<string | File[] | null>(null),
    bio: createFormControl(""),
  });
  /* eslint-enable solid/reactivity */

  // unlike the other forms, this one does not react to
  // further changes outside of our control because it's
  // unlikely that the user is going to be doing this

  const [initialBio, setInitialBio] = createSignal<readonly [string]>();

  // once profile data is loaded, copy it into the form
  createEffect(
    on(
      () => profile.data,
      (profileData) => {
        if (profileData) {
          editGroup.controls.banner.setValue(
            profileData.animatedBannerURL || null,
          );

          editGroup.controls.bio.setValue(profileData.content || "");
          setInitialBio([profileData.content || ""]);
        }
      },
    ),
  );

  // Drop a refusal as soon as the name is edited again. Clearing it on submit
  // is not enough on its own: typing the original name back makes the form
  // clean, which disables Save, so no submit ever runs and the old error would
  // sit there next to a name that is perfectly fine.
  createEffect(
    on(
      () => editGroup.controls.displayName.value,
      () => {
        if (editGroup.errors?.error) editGroup.setErrors(null);
      },
      { defer: true },
    ),
  );

  function onReset() {
    editGroup.controls.displayName.setValue(props.user.displayName);
    editGroup.controls.pronouns.setValue(props.user.pronouns ?? "");
    editGroup.controls.avatar.setValue(props.user.animatedAvatarURL);

    if (profile.data) {
      editGroup.controls.banner.setValue(
        profile.data.animatedBannerURL || null,
      );
      editGroup.controls.bio.setValue(profile.data.content || "");
      setInitialBio([profile.data.content || ""]);
    }
  }

  async function onSubmit() {
    // `pronouns` is additive; stoat-api 0.13.5 predates it
    const changes: API.DataEditUser & { pronouns?: string } = {
      remove: [],
    };

    if (editGroup.controls.displayName.isDirty) {
      changes.display_name = editGroup.controls.displayName.value.trim();
    }

    if (editGroup.controls.pronouns.isDirty) {
      const pronouns = editGroup.controls.pronouns.value.trim();
      if (pronouns) {
        changes.pronouns = pronouns;
      } else {
        changes.remove!.push("Pronouns" as never);
      }
    }

    if (editGroup.controls.avatar.isDirty) {
      if (!editGroup.controls.avatar.value) {
        changes.remove!.push("Avatar");
      } else if (Array.isArray(editGroup.controls.avatar.value)) {
        changes.avatar = await client().uploadFile(
          "avatars",
          editGroup.controls.avatar.value[0],
          CONFIGURATION.DEFAULT_MEDIA_URL,
        );
      }
    }

    if (editGroup.controls.bio.isDirty) {
      if (!editGroup.controls.bio.value) {
        changes.remove!.push("ProfileContent");
      } else {
        changes.profile ??= {};
        changes.profile.content = editGroup.controls.bio.value;
      }
    }

    let newBannerUrl: string | null = null;

    if (editGroup.controls.banner.isDirty) {
      if (!editGroup.controls.banner.value) {
        changes.remove!.push("ProfileBackground");
      } else if (Array.isArray(editGroup.controls.banner.value)) {
        changes.profile ??= {};
        changes.profile.background = await client().uploadFile(
          "backgrounds",
          editGroup.controls.banner.value[0],
          CONFIGURATION.DEFAULT_MEDIA_URL,
        );

        newBannerUrl = `${CONFIGURATION.DEFAULT_MEDIA_URL}/backgrounds/${changes.profile.background}`;
      } else {
        newBannerUrl = editGroup.controls.banner.value;
      }
    }

    await props.user.edit(changes);

    if (editGroup.controls.banner.isDirty && profile.data) {
      queryClient.setQueryData(["profile", props.user.id], {
        ...profile.data,
        animatedBannerURL: newBannerUrl,
        bannerURL: newBannerUrl,
      });
    }
  }

  const submit = Form2.useSubmitHandler(editGroup, onSubmit, onReset);

  return (
    <form onSubmit={submit}>
      <Column>
        <Form2.FileInput
          control={editGroup.controls.avatar}
          accept="image/*"
          label={t`Avatar`}
          imageJustify={false}
        />
        <Form2.FileInput
          control={editGroup.controls.banner}
          accept="image/*"
          label={t`Banner`}
          imageAspect="232/100"
          imageRounded={false}
          imageJustify={false}
        />
        <Form2.TextField
          minlength={2}
          maxlength={32}
          counter
          name="displayName"
          control={editGroup.controls.displayName}
          label={t`Display Name`}
        />
        <Form2.TextField
          maxlength={24}
          name="pronouns"
          control={editGroup.controls.pronouns}
          label={t`Pronouns`}
          placeholder={t`e.g. they/them`}
        />

        <Show when={!props.user.bot}>
          <CategoryButton
            icon={<MdBadge />}
            action="chevron"
            description={
              <Trans>Go to Account Info to edit your username</Trans>
            }
            onClick={() => navigate("account")}
          >
            <Trans>Want to change username?</Trans>
          </CategoryButton>
        </Show>

        <Text class="label">
          <Trans>Profile Bio</Trans>
        </Text>
        <Form2.TextEditor
          initialValue={initialBio()}
          control={editGroup.controls.bio}
          placeholder={t`Something cool about me...`}
        />

        <Row align>
          <Form2.Reset group={editGroup} onReset={onReset} />
          <Form2.Submit group={editGroup} requireDirty>
            <Trans>Save</Trans>
          </Form2.Submit>
          {/* The submit handler stores a rejected save on the group but
              nothing rendered it, so a refused display name looked like the
              button simply did nothing. */}
          <Switch>
            <Match when={editGroup.errors?.error}>
              {err(editGroup.errors!.error)}
            </Match>
            <Match when={editGroup.isPending}>
              <CircularProgress />
            </Match>
          </Switch>
        </Row>
      </Column>
    </form>
  );
}
