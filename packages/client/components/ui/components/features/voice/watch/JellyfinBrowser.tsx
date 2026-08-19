import { For, Show, createSignal, onMount } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { JellyfinConnect } from "./JellyfinConnect";
import { JellyfinApi, type JfItem } from "./providers/jellyfin/api";
import { isWatchableKind, itemLabel, ticksToMs } from "./providers/jellyfin/jellyfinWire";
import { type SavedServer, listServers, removeServer } from "./providers/jellyfin/servers";
import { registerServers } from "./providers/jellyfin/transport";

/**
 * Browse a saved Jellyfin and start a watch session (plan §5.5). A saved
 * server is picked (or added via JellyfinConnect), its libraries and
 * "Continue watching" listed, folders drilled into, items searched; clicking
 * a watchable item starts the session for the whole call. Everything is
 * fetched by THIS viewer from THEIR server — Sloga is never on the path.
 */
export function JellyfinBrowser() {
  const voice = useVoice();
  const { t } = useLingui();
  const watch = voice.watch;

  const [servers, setServers] = createSignal<SavedServer[]>(listServers());
  const [adding, setAdding] = createSignal(servers().length === 0);
  const [active, setActive] = createSignal<SavedServer | undefined>();
  const [crumbs, setCrumbs] = createSignal<{ id?: string; name: string }[]>([]);
  const [items, setItems] = createSignal<JfItem[]>([]);
  const [search, setSearch] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();

  const api = () => {
    const s = active();
    return s ? new JellyfinApi(s) : undefined;
  };

  onMount(() => {
    // Keep the shells' forwarder in sync with what we have saved.
    void registerServers(listServers());
  });

  async function openServer(s: SavedServer) {
    setActive(s);
    setCrumbs([{ name: s.name }]);
    setSearch("");
    await loadRoot(s);
  }

  async function loadRoot(s: SavedServer) {
    setLoading(true);
    setError(undefined);
    try {
      const jf = new JellyfinApi(s);
      const [views, resume] = await Promise.all([jf.views(), jf.resume().catch(() => ({ Items: [] }))]);
      const resumeItems = (resume.Items ?? []).map((i) => ({ ...i, __resume: true }) as JfItem);
      setItems([...resumeItems, ...views.Items]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Couldn't load libraries`);
    } finally {
      setLoading(false);
    }
  }

  async function openFolder(item: JfItem) {
    const jf = api();
    if (!jf) return;
    setLoading(true);
    setError(undefined);
    setCrumbs((c) => [...c, { id: item.Id, name: item.Name }]);
    try {
      const r = await jf.items({ parentId: item.Id, limit: 200 });
      setItems(r.Items);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Couldn't load items`);
    } finally {
      setLoading(false);
    }
  }

  async function runSearch() {
    const jf = api();
    if (!jf) return;
    const term = search().trim();
    if (!term) {
      const s = active();
      if (s) await loadRoot(s);
      return;
    }
    setLoading(true);
    setError(undefined);
    setCrumbs((c) => [c[0], { name: t`Search: ${term}` }]);
    try {
      const r = await jf.items({ searchTerm: term, limit: 100 });
      setItems(r.Items);
    } catch (e) {
      setError(e instanceof Error ? e.message : t`Search failed`);
    } finally {
      setLoading(false);
    }
  }

  function backTo(index: number) {
    const s = active();
    if (!s) return;
    if (index === 0) {
      setCrumbs([{ name: s.name }]);
      setSearch("");
      void loadRoot(s);
    }
  }

  function pickItem(item: JfItem) {
    const s = active();
    if (!s) return;
    if (item.IsFolder || !isWatchableKind(item.Type)) {
      void openFolder(item);
      return;
    }
    void watch.start({
      provider: "jellyfin",
      server_url: s.baseUrl,
      server_id: s.id,
      item_id: item.Id,
      item_name: item.Name,
      item_kind: item.Type,
      runtime_ms: ticksToMs(item.RunTimeTicks),
    });
  }

  function forget(s: SavedServer) {
    const next = removeServer(s.id);
    setServers(next);
    void registerServers(next);
    if (active()?.id === s.id) setActive(undefined);
    if (next.length === 0) setAdding(true);
  }

  return (
    <Box>
      <Show
        when={!adding()}
        fallback={
          <JellyfinConnect
            onCancel={() => {
              if (servers().length > 0) setAdding(false);
              else watch.setPickerOpen(false);
            }}
            onDone={(s) => {
              const next = listServers();
              setServers(next);
              setAdding(false);
              void openServer(s);
            }}
          />
        }
      >
        <Show
          when={active()}
          fallback={
            <ServerList>
              <ListHead>{t`Choose a server`}</ListHead>
              <For each={servers()}>
                {(s) => (
                  <ServerRow onClick={() => void openServer(s)}>
                    <Symbol size={18}>dns</Symbol>
                    <ServerName>
                      <strong>{s.name}</strong>
                      <ServerUrl>{s.baseUrl}</ServerUrl>
                    </ServerName>
                    <Spacer />
                    <span onClick={(e) => e.stopPropagation()}>
                      <IconButton
                        size="xs"
                        variant="tonal"
                        onPress={() => forget(s)}
                        use:floating={{ tooltip: { placement: "top", content: t`Forget this server` } }}
                      >
                        <Symbol>logout</Symbol>
                      </IconButton>
                    </span>
                  </ServerRow>
                )}
              </For>
              <Button variant="secondary" onPress={() => setAdding(true)}>
                <Symbol>add</Symbol>
                {t`Add another server`}
              </Button>
            </ServerList>
          }
        >
          {(s) => (
            <>
              <Toolbar>
                <IconButton size="xs" variant="tonal" onPress={() => setActive(undefined)}>
                  <Symbol>arrow_back</Symbol>
                </IconButton>
                <Crumbs>
                  <For each={crumbs()}>
                    {(c, i) => (
                      <>
                        <Show when={i() > 0}>
                          <Symbol size={14}>chevron_right</Symbol>
                        </Show>
                        <Crumb onClick={() => backTo(i())}>{c.name}</Crumb>
                      </>
                    )}
                  </For>
                </Crumbs>
                <Spacer />
                <SearchInput
                  type="search"
                  placeholder={t`Search ${s().name}`}
                  value={search()}
                  onInput={(e) => setSearch(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && void runSearch()}
                />
              </Toolbar>

              <Show when={error()}>
                <ErrorNote>{error()}</ErrorNote>
              </Show>

              <Show when={loading()}>
                <Muted>{t`Loading…`}</Muted>
              </Show>

              <Grid>
                <For each={items()}>
                  {(item) => (
                    <Card onClick={() => pickItem(item)}>
                      <Thumb
                        style={{
                          "background-image": item.ImageTags?.Primary
                            ? `url("${api()!.imageUrl(item.Id, 300, item.ImageTags.Primary)}")`
                            : undefined,
                        }}
                      >
                        <Show when={!item.ImageTags?.Primary}>
                          <Symbol size={28}>{item.IsFolder || !isWatchableKind(item.Type) ? "folder" : "movie"}</Symbol>
                        </Show>
                        <Show when={isWatchableKind(item.Type) && !item.IsFolder}>
                          <PlayBadge>
                            <Symbol size={18}>play_arrow</Symbol>
                          </PlayBadge>
                        </Show>
                      </Thumb>
                      <CardLabel title={itemLabel(item)}>{itemLabel(item)}</CardLabel>
                    </Card>
                  )}
                </For>
              </Grid>
              <Show when={!loading() && items().length === 0 && !error()}>
                <Muted>{t`Nothing here.`}</Muted>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </Box>
  );
}

const Box = styled("div", { base: { display: "flex", flexDirection: "column", gap: "var(--gap-md)", width: "100%", minHeight: 0 } });
const ServerList = styled("div", { base: { display: "flex", flexDirection: "column", gap: "var(--gap-sm)", maxWidth: "44ch", margin: "auto", width: "100%" } });
const ListHead = styled("div", { base: { fontSize: "12px", color: "var(--md-sys-color-on-surface-variant)" } });
const ServerRow = styled("div", {
  base: {
    display: "flex", alignItems: "center", gap: "var(--gap-sm)", padding: "8px 10px", borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)", cursor: "pointer",
    _hover: { background: "var(--md-sys-color-surface-container-highest)" },
  },
});
const ServerName = styled("div", { base: { display: "flex", flexDirection: "column", minWidth: 0 } });
const ServerUrl = styled("span", { base: { fontSize: "11px", color: "var(--md-sys-color-on-surface-variant)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
const Spacer = styled("span", { base: { flex: "1 1 auto" } });
const Toolbar = styled("div", { base: { display: "flex", alignItems: "center", gap: "var(--gap-sm)" } });
const Crumbs = styled("div", { base: { display: "flex", alignItems: "center", gap: "2px", fontSize: "13px", minWidth: 0, overflow: "hidden" } });
const Crumb = styled("button", {
  base: { border: "none", background: "none", color: "var(--md-sys-color-on-surface)", cursor: "pointer", padding: 0, whiteSpace: "nowrap", _hover: { textDecoration: "underline" } },
});
const SearchInput = styled("input", {
  base: {
    width: "min(220px, 40vw)", padding: "5px 8px", borderRadius: "8px", fontSize: "13px",
    border: "1px solid var(--md-sys-color-outline-variant)", background: "var(--md-sys-color-surface-container-high)", color: "var(--md-sys-color-on-surface)",
  },
});
const Grid = styled("div", {
  base: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "var(--gap-sm)",
    overflowY: "auto", minHeight: 0, paddingBottom: "4px",
  },
});
const Card = styled("div", { base: { display: "flex", flexDirection: "column", gap: "4px", cursor: "pointer" } });
const Thumb = styled("div", {
  base: {
    position: "relative", aspectRatio: "2 / 3", borderRadius: "8px", background: "var(--md-sys-color-surface-container-high)",
    backgroundSize: "cover", backgroundPosition: "center", display: "grid", placeItems: "center",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
const PlayBadge = styled("div", {
  base: {
    position: "absolute", right: "6px", bottom: "6px", width: "28px", height: "28px", borderRadius: "50%",
    background: "color-mix(in srgb, var(--md-sys-color-primary) 90%, transparent)", color: "var(--md-sys-color-on-primary)",
    display: "grid", placeItems: "center",
  },
});
const CardLabel = styled("span", { base: { fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
const Muted = styled("div", { base: { fontSize: "13px", color: "var(--md-sys-color-on-surface-variant)", textAlign: "center", padding: "var(--gap-md)" } });
const ErrorNote = styled("div", { base: { fontSize: "12px", padding: "6px 8px", borderRadius: "6px", background: "var(--md-sys-color-error-container)", color: "var(--md-sys-color-on-error-container)" } });
