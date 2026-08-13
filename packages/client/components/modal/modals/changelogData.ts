import type { ChangelogResponse } from "./Changelog";

/**
 * Sloga patch notes, newest first.
 *
 * To publish a new entry: add an object to the TOP of this array with a new
 * unique `id` (bump the number) and a `published_at` ISO timestamp. Users see
 * the newest entry once, automatically, next time they open the app.
 */
export const CHANGELOGS: ChangelogResponse[] = [
  // Screen-share annotation (tech-support-mode plan §2), published only AFTER
  // the two-account live leg passed (2026-08-13). Copy constraints, all
  // load-bearing (reviewed 2026-08-13):
  // - The ink transits the SERVER in plaintext, like captions. Sitting under
  //   the v0.39.0 E2EE headline, this entry must SAY so — silence inherits an
  //   encryption halo drawing is not entitled to. Never private/E2EE/verified.
  // - The banner names "who the server says is drawing" — server-ASSERTED
  //   attribution, never presented as proven.
  // - Consent enforcement is attributed to the SERVER ("checks every stroke"),
  //   not worded as an unattributed absolute.
  // - The escalation step (remote control) stays desktop-to-desktop and the
  //   copy says so wherever it points at it; drawing itself is cross-platform.
  // - A stroke is a picture, never input — "can't click, type, or touch" is
  //   the honest capability statement, not a protection claim.
  {
    id: "sloga-2026-08-13-4",
    title: "Patch Notes",
    published_at: "2026-08-13T07:30:00.000Z",
    markdown_content: `## v0.40.0 — Draw on their screen

### ✏️ Point at things instead of taking the mouse
- **When someone shares their screen, they can now let you draw on it.** Circle the button, cross out the wrong menu, sketch an arrow — everyone in the call sees the ink right on the share, and it fades away after a few seconds.
- **It's the step before Tech support mode hands over the mouse.** Most of the time you don't need someone's keyboard — you need "no — **that** one." Drawing points; it can't click, type, or touch anything on their computer. The ink itself travels through Sloga to reach everyone, like live captions do — it's the mouse-and-keyboard channel that's end-to-end encrypted, not the drawing.
- **Nobody draws uninvited.** Drawing is off by default. The person sharing picks each helper by name — the server checks every stroke against that list — and a banner on their screen always names who the server says is drawing.
- **One button stops everything.** "Stop all drawing" instantly clears the ink and revokes everyone at once — and permission ends by itself when the share ends, so the next share always starts from zero.
- **On the web today.** The desktop and mobile apps pick it up with their next update — drawing works wherever the call does, while handing over the mouse itself stays desktop-to-desktop.

*Sloga — Hop on.*`,
  },
  // Positioning entry: names the ALREADY-SHIPPED remote control (public since
  // desktop 0.23.0) as the flagship "tech support mode". No feature ships with
  // this entry. Copy constraints, all load-bearing (reviewed 2026-08-13):
  // - The E2EE claim stays scoped to MOUSE/KEYBOARD INPUT (the sealed pairwise
  //   channel). Never "we can't see your screen" / "protected from Sloga" —
  //   the SFU relays the screen media and the server introduces the parties.
  // - The world-first claim keeps its qualifier: "end-to-end-encrypted remote
  //   control" — bare "remote control" is contestable (Teams/Zoom give-control).
  // - No unattended-access or IT-admin framing; every session starts with the
  //   person being helped and costs a confirmation on their own computer.
  // - Scam warning stays Sloga-scoped, per the shipped v0.27.0 precedent.
  // - Never mention drawing/annotation (dark until it ships) or any
  //   per-app/per-window claim (does not exist).
  {
    id: "sloga-2026-08-13-3",
    title: "Patch Notes",
    published_at: "2026-08-13T04:00:00.000Z",
    markdown_content: `## v0.39.0 — Tech support mode

### 🛠️ Call a friend, hand them your mouse
- **This is the feature we'd tell your family about.** When someone you trust gets stuck, call them on Sloga: they share their screen, hand you their mouse and keyboard, and you fix it — instead of talking them through it button by button.
- **It's built in, and your mouse and keyboard input is end-to-end encrypted.** It travels encrypted between the two computers; Sloga relays it and can't read it. No other mainstream chat app has end-to-end-encrypted remote control built in.
- **The person being helped stays in charge, always.** It only ever starts with them: they pick the helper by name and confirm on their own computer before anything is handed over, a bar with a Stop button stays pinned to their screen the whole time, and **Ctrl+Shift+Alt+Q** ends it instantly from anywhere.
- **It's for people you already trust — never for strangers.** ⚠️ Nobody from Sloga support will ever ask for control of your computer. If anyone asks for control while claiming to be staff or support, it's a scam — refuse, and tell us at report@sloga.gg.
- **Windows desktop to Windows desktop**, whole-screen shares only — sharing a single window won't offer it, because control would reach the whole screen behind that window.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 2 ("ask for a turn" + the capability beacon).
  // DESKTOP-ONLY for the same reason as slice 1 — every surface it adds sits
  // inside the ENABLE_REMOTE_CONTROL gate, lit only in the desktop build.
  // Copy constraints, all load-bearing:
  // - ASKING GRANTS NOTHING. It is a request the streamer chooses to act on;
  //   never word it as joining the rotation, or as if it takes a turn itself.
  // - Every turn still costs the native confirmation on the streamer's own
  //   machine. That dialog is the point, not friction, and must never read as
  //   something the feature can skip.
  // - The "on desktop" marker is a SELF-REPORT each client makes about itself
  //   and the server relays unverified. Never say verified/confirmed/checked;
  //   its absence means "hasn't said", never "can't". Saying that plainly is
  //   also what keeps the copy honest that the server is not a trust anchor.
  // - Real input on a real machine — never dressed up as a game abstraction.
  {
    id: "sloga-2026-08-13-2",
    title: "Patch Notes",
    published_at: "2026-08-13T02:00:00.000Z",
    markdown_content: `## v0.38.0 — Ask for a turn

### 🙋 Ask for the controller instead of waiting to be offered
- **When someone is sharing their screen on the desktop app, you can now ask them for a turn.** Your request appears next to their rotation queue, and they decide whether to add you — asking never takes control on its own.
- **The person sharing is still asked on their own computer before anyone can type or click.** That happens on every single turn and there is no way around it. It is the point of the feature, not a formality.
- **The rotation now marks who is on desktop**, so the streamer can see at a glance who is able to take a turn at all. That marker is what each person's app says about itself — Sloga passes it along rather than checking it.
- Taking a turn stays desktop-to-desktop; people on the web or their phone are in the call as normal, they just can't drive.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 1 (the rotation queue). DESKTOP-ONLY: the panel
  // is gated on ENABLE_REMOTE_CONTROL, which is lit only in the desktop
  // build, so this ships in the desktop installer and NOT to web/android/
  // linux (where it would be dark). Copy constraints, all load-bearing:
  // - It is REAL input on a REAL machine — never dress it up as a game
  //   abstraction that hides that (plan §3). Say "type and click on your
  //   computer".
  // - Every turn costs a native OS confirmation on the sharer's machine, and
  //   that dialog IS the safety — the copy must present it as the point, not
  //   a nuisance, and must not imply it can be skipped.
  // - The queue is the streamer's own local order; never imply it is
  //   server-verified, and never imply remote control is protected from the
  //   server (a compromised sharer renderer is equivalent to it).
  // - The control gap is real and is stated, not hidden.
  {
    id: "sloga-2026-08-13",
    title: "Patch Notes",
    published_at: "2026-08-13T00:30:00.000Z",
    markdown_content: `## v0.37.0 — Pass the controller

### 🎮 Hand the controller around your screen share
- **On the desktop app, when you share your whole screen you can now pass control of your keyboard and mouse around the group like a physical controller.** Build a rotation from the people in the call and press Next to hand over; everyone can see whose turn it is.
- **Every turn asks you on your own computer first.** Handing someone the controller means letting them really type and click on your machine — so Sloga puts a confirmation on your screen before anyone can, and there is no way around that. That prompt is the point, not a nuisance.
- **Set an optional turn timer** and control passes to the next person on its own when the time is up.
- During each handoff there's a brief moment where nobody is driving — that's the controller being passed from one person to the next, not a glitch.
- Remote control is desktop-to-desktop: people on the web or their phone show up in the call, but can't take a turn.

*Sloga — Hop on.*`,
  },
  // Pass-the-controller slice 0 (controller VISIBILITY only). Copy
  // constraints that are load-bearing: this is a display, never a
  // protection — it must not be worded as if it stops or limits anyone,
  // and it must never imply the server is kept out of anything (a
  // compromised sharer renderer is equivalent to the server). Remote
  // control itself is still Windows-desktop-to-desktop; the BADGE is
  // cross-platform because it rides plain channel events, so the copy
  // says "see", never "take". The last row is the honest limit: the map
  // is event-sourced and resets when you leave a call, so a mid-session
  // join can miss it until the next handoff — a reconnect backfills.
  {
    id: "sloga-2026-08-12-2",
    title: "Patch Notes",
    published_at: "2026-08-12T19:30:00.000Z",
    markdown_content: `## v0.36.0 — Everyone can see who's driving

### 🖱️ You can see who holds the controller
- **When someone is controlling a shared screen, the tile says so.** A "Controlled by …" badge sits on the screen-share for as long as the session lasts — always visible, no hovering required, so nobody has to wonder who just moved that mouse.
- **The call roster now lists every control session in the channel**, naming who is driving whose screen.
- **You don't have to be in the call to see it.** Anyone who can view the channel sees the same thing, so a moderator can tell who is driving without joining first.
- The badge is hidden from the person doing the driving — their own capture bar already says so.
- If you join a call that already has a session running, the badge may not appear until control next changes hands. Reopening Sloga always shows the current state.

*Sloga — Hop on.*`,
  },
  // All four rows shipped unit-proven but without a live leg (user's call:
  // they bug-check in prod). Copy constraints that are load-bearing: the
  // whisper row must never claim the server can't hear it — its privacy is
  // SFU-enforced, not cryptographic. The timelock row MAY claim nobody
  // including us can open early; that one is a real cryptographic gate
  // (drand round in the age header). The banner caveat for whispering to
  // older clients is deliberate: old builds hear the track but have no
  // banner UI.
  {
    id: "sloga-2026-08-12",
    title: "Patch Notes",
    published_at: "2026-08-12T03:30:00.000Z",
    markdown_content: `## v0.35.0 — A whisper, a seal, a subtitle, a shield

### ⏳ Messages that refuse to open early
- **Seal a message until a time you choose.** The composer tray has a new lock-clock button: write your message, pick the moment, and until then nobody can read it — not the recipient, not Sloga, not even you. That's not a policy, it's cryptography: the message is locked to a public randomness beacon that only produces the key when the time arrives. Recipients see a countdown that opens on its own.

### 🤫 Whisper to one person in a call
- **Pick someone in a voice call and whisper — only they hear you.** While you whisper, your normal mic goes quiet for everyone else (push-to-talk and captions included), and the person you're whispering to sees a banner naming you. When you stop, your mic comes back exactly as it was.
- If the person you whisper to hasn't updated yet, they're still the only one who hears you — they just won't see the banner until they update.

### 💬 Captions keep the original line
- **Translated captions now show what was actually said** in the speaker's language underneath the translation, so you can check the machine's work.
- **A closed-captions button now lives in the call controls**, so you can turn captions on or off mid-call. On end-to-end encrypted calls it stays off and says why, instead of pretending.

### 🛡️ Screenshare privacy shield
- **Sudden pop-ups on a shared screen get pixelated before your viewers read them.** Turn on the shield in the screen-share dialog when sharing a whole monitor: it watches the corner where notifications appear, and anything that shows up abruptly is mosaicked until it's gone. A corner that's always busy is left alone — it only reacts to surprises.

*Sloga — Hop on.*`,
  },
  // All three rows shipped without a live two-account leg (user's call: they
  // bug-check in prod). Server side is test-proven under both DB drivers;
  // the note row, private-profile card and spoiler gate have never been
  // watched rendered. Copy promises behavior, not appearance.
  {
    id: "sloga-2026-08-11-2",
    title: "Patch Notes",
    published_at: "2026-08-11T19:00:00.000Z",
    markdown_content: `## v0.34.0 — A note, a curtain, a warning

### 🤝 Friend requests can say why
- **Attach a note when sending a friend request** so your future friend isn't left asking "who is this?". The note shows on the incoming request and on the profile card, and it disappears once the request is accepted or declined.

### 🔒 Profiles can go friends-only
- **A new Profile visibility setting** (Settings → Profile) limits your bio, banner and linked channels to friends. People in your servers still see your name and avatar; everyone else is told the profile is private — enforced by the server, not just hidden in the app.

### 🙈 Spoiler channels
- **Mark a text channel as a spoiler** (Channel settings → Overview) and members must choose to reveal it before anything is shown — no more marking a channel as mature just to hide episode discussion. Each device remembers what you've revealed.

*Sloga — Hop on.*`,
  },
  // Both rows are unit-proven and, for translation, live-proven against the
  // real endpoint — but neither has been watched in a live call. The
  // transcription row deliberately promises only that impossible lines are
  // dropped: a hallucination short enough to be sayable in the time available
  // is indistinguishable from speech and still gets through, so the copy does
  // not claim the invented lines are gone.
  {
    id: "sloga-2026-08-11",
    title: "Patch Notes",
    published_at: "2026-08-11T09:00:00.000Z",
    markdown_content: `## v0.33.0 — Fewer words nobody said

### 🎙️ Transcription stops inventing sentences
- **Lines that could not physically have been spoken are now thrown away.** The speech model fills silence with fluent, confident sentences — people testing a call alone were seeing replies they never said, attributed to them by name. The transcript now checks whether there was actually enough speech in the audio to fit the words that came back, and drops what does not add up.
- Short interjections are still taken at their word, because a real "oh, no" and an invented one look exactly the same to a clock.

### 🌍 Live translation gets out of its own way
- **Translation that is going to fail now fails instantly**, showing the original text, instead of stalling for seconds first. When the translation service starts refusing requests, the app backs off for a moment rather than queueing into the wall — which is what made captions crawl.
- Requests that hang are given up on, a few are allowed at a time instead of all at once, and a genuine hiccup is retried once.

*Sloga — Hop on.*`,
  },
  // The worker move is live-verified against the built bundle (model loaded,
  // inference completed in the worker, main thread serviced work mid-inference,
  // all model/runtime fetches same-origin) — but not yet in a real multi-party
  // call. The freeze it fixes was reported from the field on 2026-08-10. The
  // Give control label row below still describes code, not observed UI.
  {
    id: "sloga-2026-08-10-4",
    title: "Patch Notes",
    published_at: "2026-08-10T22:00:00.000Z",
    markdown_content: `## v0.32.0 — Transcription minds its manners

### 🎙️ Transcribing a call no longer freezes the app
- **The speech-to-text model now runs on its own thread.** On computers where transcription ran slower than the conversation, turning it on could freeze the whole app and eventually crash it. The app now stays responsive no matter how hard the model is working — worst case the transcript falls behind, and it tells you when it does.
- **If transcription breaks, it breaks alone.** A failure in the transcriber now ends transcription, not your call — and turning it on again starts clean.

### 🖱️ Give control says so
- **The Give control button now carries its label** instead of being one more blue circle that read exactly like an unmuted mic. *(Windows desktop only, while sharing your whole screen.)*

*Sloga — Hop on.*`,
  },
  // The share-icon repair was observed directly (the wrong glyph was read out
  // of a live call's DOM before the fix). The other two rows were NOT seen
  // rendered: Give control needs a live whole-screen share plus the native
  // probe, and the encryption message only appears on an install whose keys
  // belong to another account. Both are described as what the code does, and
  // neither promises an appearance. The reset itself IS proven — an operator
  // ran the same underlying flow from Settings on a mismatched install and
  // came back encrypted; only the in-call entry point to it is unobserved.
  {
    id: "sloga-2026-08-10-3",
    title: "Patch Notes",
    published_at: "2026-08-10T09:00:00.000Z",
    markdown_content: `## v0.31.0 — Buttons that tell the truth

### 🖱️ Give control moved next to Share screen
- **It now sits directly beside the share button**, instead of further along the call bar away from the thing it acts on.
- **It looks like an action instead of another toggle** — a filled pill with a cursor on it, replacing the monitor icon that disappeared into a row of identical circles. It still only shows up while you're sharing your whole screen. *(Windows desktop only.)*

### 🔧 Two repairs
- **The share-screen button was wearing the wrong icon.** It showed the crossed-out "stop sharing" symbol when you weren't sharing, and the plain one while you were — exactly backwards. The tooltip was right the whole time, which is probably why it survived this long.
- **One encrypted-call failure now explains itself.** If this device's encryption keys were set up under a *different* account, calls here can never be encrypted. That used to show up as a red "Not encrypted" badge and nothing else — no reason, no way forward. The call now tells you what happened and offers to reset this device's encryption so it can be set up again under the account you're signed in as. *(Resetting erases encrypted messages stored on this device — it asks twice before doing anything.)*

*Sloga — Hop on.*`,
  },
  // Meadow and Space are code-verified (rendered in a bundled harness; the
  // Space frames were checked frame-against-frame), but the animation has not
  // been exercised against a live camera track, so the copy describes the
  // scene, not call behavior. The retired Arcade/Gamepad ids fall back to
  // "no background" by design.
  {
    id: "sloga-2026-08-10-2",
    title: "Patch Notes",
    published_at: "2026-08-10T08:30:00.000Z",
    markdown_content: `## v0.30.0 — Fresh scenery

### 🌄 A meadow and the night sky
- **Meadow** — a rolling green hill under a summer sky, hand-drawn in the style of a certain classic desktop wallpaper.
- **Space** — our first *animated* background: a deep-space scene where the stars genuinely twinkle behind you while you talk.
- These replace the Arcade and Gamepad backgrounds. If you had one of those selected, your camera quietly falls back to no background — pick a new favorite in Settings → Voice & Video.

### 🖼️ Bring your own background
- **The upload button under the background picker works now.** It opens a real file picker instead of doing nothing. Your image stays on your device — backgrounds are composited locally before your video is encrypted and sent.
- Also fixed: the camera preview's Stop button wore a gradient that belonged to no theme. It dresses like the rest of the app now.

*Sloga — Hop on.*`,
  },
  // The four camera presets are code-verified (all render in a bundled
  // harness) but nobody has applied one to a live camera track in the real
  // settings screen yet, so the copy describes what they look like, not how
  // they behave on a call.
  {
    id: "sloga-2026-08-10",
    title: "Patch Notes",
    published_at: "2026-08-10T04:30:00.000Z",
    markdown_content: `## v0.29.0 — Dress up your camera

### 🎨 Four new camera backgrounds
- **A Sloga wallpaper and three game themes join the background picker**: the Sloga "O" tiled on black, a synthwave sun over a grid, a spread of pixel hearts and stars, and tone-on-tone controller silhouettes.
- **They render on your machine, like every background.** Your real room never leaves your computer — the replacement happens before the video is encrypted and sent.

### 🕹️ Slogaball, tightened up
- **A run is now 5 balls instead of 10.** Rounds were outlasting the wait they were built to fill; a shorter rack keeps every shot worth lining up, and the bucket still pays a free ball.

*Sloga — Hop on.*`,
  },
  // The voice-awareness and Slogatron sections ship lit in this build, but
  // neither has been seen in a real call -- the badge needs a second account
  // screensharing, the picker needs a logged-in session. Claims here are
  // written from the code that ships, and nothing is promised that a reader
  // could not check on their own screen. The multi-instance row is Windows
  // only because the Electron shell has no such command; the client hides it
  // on a shell that does not report it, so no note is needed for Linux.
  {
    id: "sloga-2026-08-09",
    title: "Patch Notes",
    published_at: "2026-08-09T22:00:00.000Z",
    markdown_content: `## v0.28.0 — See who's already talking

### 👀 Know before you join
- **A red LIVE badge marks anyone sharing their screen** in a voice channel, so you can tell there is something worth joining before you join it.
- **The badge no longer disappears the moment you join.** It used to show only to people standing outside the channel, so the sidebar said one thing before you joined and another after.
- **The share icon now means a screen is actually on.** Stopping your video but leaving screen audio running used to keep the icon lit with nothing behind it.
- **Friends and DMs show "Voice" when someone is already in a call**, so you can see not to ring somebody mid-conversation. It covers the channels you can see — a friend sitting in a server you are not in still reads as free, because that roster never reaches you.
- **There is deliberately no hover preview.** Call video is end-to-end encrypted: the server holds no picture to show you, and watching would mean joining. The tooltip tells you video is live instead of pretending to show it.

### 🕹️ Slogatron
- **A second game for waiting out a call.** Ride the rim of a segmented web, shoot down your own lane at whatever climbs it, then dive through to the next web past whatever is left standing. Three lives, one superzapper per web, eight web shapes.
- **The game chip opens a picker now**, since it can no longer mean one game. Slogaball is still there, and each game keeps its own paused field per channel — switching games never drops you back into the wrong one.

### 🪟 Run two Slogas at once (Windows desktop)
- **A checkbox in desktop settings lets a second copy of Sloga start**, so you can be signed into two accounts on one PC at the same time.
- **Each copy gets its own login, its own encryption store and its own window layout.** The first one keeps everything exactly where it already was, so turning this back off puts you where you were.
- **It takes effect at next launch**, because the shell has to decide which copy it is before the window exists.

### 🔐 A clearer encryption failure
- **If this device's encryption store belongs to a different account, Sloga now says so.** It used to show the call as "Not encrypted" and a screen share that connected and then sent nothing, with no reason given anywhere.
- **That message carries a Reset encryption button.** Staying unencrypted for the call you are in is still a legitimate choice; the reset is the thing that fixes the next one. It asks you to prove the account is yours first, and it warns you that encrypted messages stored on this device go with it.

*Sloga — Hop on.*`,
  },
  // The remote-control section below is the v0.21.0 draft (c9d2f53a) that was
  // held back under "never announce a dark feature". It is no longer dark:
  // desktop 0.23.0 is the first installer built with
  // VITE_CFG_ENABLE_REMOTE_CONTROL=true, and the instance flag has been on
  // since 2026-08-07. Restored near-verbatim, but every claim was re-checked
  // against the shipping build rather than trusted from the draft. The
  // UseRemoteControl permission bit is deliberately NOT mentioned: it is
  // code-verified for server channels and has never run a live leg.
  {
    id: "sloga-2026-08-08-4",
    title: "Patch Notes",
    published_at: "2026-08-08T18:30:00.000Z",
    markdown_content: `## v0.27.0 — Hand someone your keyboard

### 🖥️ Give control of your screen
- **While you're sharing your whole screen, you can hand someone your mouse and keyboard.** Click the monitor icon in the call bar, pick the person, and they can help you directly instead of talking you through it.
- **It only ever starts with you.** Nobody can request or take control — you choose the person, and Windows itself asks you to confirm before anything is handed over.
- **Stop instantly, any time.** A bar stays pinned to the top of your screen for the whole session with a Stop button, and **Ctrl+Shift+Alt+Q** ends it from anywhere — even mid-click.
- **Your mouse and keyboard input is encrypted between the two computers.** We relay it and can't read it. The confirmation you'll see spells out exactly what that does and doesn't cover.
- **Whole-screen shares only.** If you're sharing a single window we won't offer it, because control reaches the whole screen behind that window — including what you didn't share.
- ⚠️ **Nobody from Sloga support will ever ask you for control of your computer.** If someone claiming to be staff or support asks, it's a scam — refuse, and tell us at report@sloga.gg.
- **Windows desktop only** for now — it needs the native app.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08-3",
    title: "Patch Notes",
    published_at: "2026-08-08T16:10:00.000Z",
    markdown_content: `## v0.26.0 — Settings you can find, and a button you could not see

### ⚙️ Settings, rearranged
- **The pages you actually change are at the top now.** Account holds your profile, sessions and connections — and My Bots, which used to sit off on its own.
- **App Settings opens with Appearance and Notifications.** It was called Client Settings, it sat below a block of links, and Advanced used to share a row with Sign out.
- **Everything that leaves Sloga is grouped under About at the bottom**, and those entries tell you they open outside the app *before* you click rather than after.

### 🎨 The colors behind two small things
- **The button on a success message is visible again.** It had been drawing completely transparent, with near-black text on a near-black background — present, but impossible to read. Success and warning now use real colors, matched to the same green as an online dot.
- **Text boxes show their focus and error outlines again.** They pointed at the same missing colors.

### ⬇️ Updates that turn up on their own (Windows desktop)
- **The update arrow appears while Sloga is open.** It only looked for updates at launch and then once an hour, so unless you quit and reopened, you could sit next to a released update for a long time without seeing it.
- **Sloga also checks the moment you come back to the window** — usually the moment you would want to know.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08-2",
    title: "Patch Notes",
    published_at: "2026-08-08T13:20:00.000Z",
    markdown_content: `## v0.25.0 — Light mode, and colors that do something

### 🎨 The appearance menu works
- **Light mode is actually light.** It used to turn the text dark but leave the background dark too, which made most of the app unreadable. The colors were being overwritten right after the theme worked them out, so only half the switch ever happened.
- **Pick a palette.** *Sloga* is the look you already know, and it is still the default. *Material You* builds every color in the app out of one accent you choose.
- **The accent swatches, contrast levels and color styles all do something now.** They were being calculated and then thrown away. They live under Material You, and they are hidden under Sloga, where they had nothing to change.
- **Labels on buttons are readable.** White text on the Sloga blue was well under the contrast a small label needs, so text on bright buttons is dark now instead of white. You will notice this on the sign-up button and anywhere a channel is selected.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-08",
    title: "Patch Notes",
    published_at: "2026-08-08T06:30:00.000Z",
    markdown_content: `## v0.24.0 — Screen share you can actually read

### 🖥️ Sharper screen sharing
- **Shared screens go up to 4K now.** Every quality tier was quietly capped at 720p before, whichever one you picked.
- **Roughly double the bitrate at every tier**, so fine detail survives instead of dissolving.
- **The encoder protects detail instead of framerate** at 1080p and above. Small text stays readable while the picture moves, rather than smearing.
- Sharing at 60FPS, or on the 720p fallback, still favors smoothness — those are the settings where you asked for motion.

### ⬇️ One-click updates on Windows desktop
- **A green arrow appears next to your name when an update is ready.** Click it and Sloga installs the update and restarts itself — no installer to click through.
- **The arrow stays until you use it**, so "later" no longer means "ask me again next launch".

### 👥 Friends and profiles
- **Add Friend moved to the left**, next to the tabs, with a smaller search box beside it.
- **A refused display name now tells you why** instead of quietly doing nothing, and the message clears the moment you edit the name again.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-07-2",
    title: "Patch Notes",
    published_at: "2026-08-07T22:15:00.000Z",
    markdown_content: `## v0.23.0 — Unread counts, not just dots

### 🔢 How much did you actually miss?
- **Servers, DMs and channels now show how many messages are waiting**, instead of a plain dot. It counts everything since you last read and stops at 99+.
- **The badge turns pink when there's an attachment in what you missed** — a file or an image landed while you were away.
- **It turns red when someone mentioned you**, so a ping never hides inside a big number.
- **Muted channels stay out of a server's total**, the same way they already stay out of its unread mark.
- Read a channel somewhere else? The number clears itself the next time this app reconnects.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-07",
    title: "Patch Notes",
    published_at: "2026-08-07T20:00:00.000Z",
    markdown_content: `## v0.22.0 — A plus sign where you'd expect one

### ➕ Making channels without the guesswork
- **Every category header now has a + button.** Hover it and click — the new channel lands in that category, where you asked for it.
- **The server name has a + too**, next to the calendar and settings icons. It opens a little menu: **Create channel** or **Create category**. No more right-clicking around to find them.
- **The create-channel box lets you pick the category** on the way in. Leave it on **No category** and the channel sits at the top level, same as before.

### 🎚️ A sidebar that stays where you put it
- **Drag the divider between your channels and the member list** to give either one more room. Double-click it to snap back.
- **Your name and mic controls stay put when you collapse the channel list** — the bar shrinks onto the server rail instead of disappearing.

### 🎤 Calls
- **The microphone you picked in Settings is the one that gets used** when you join a call. If it's unavailable, we say so instead of quietly connecting you muted.
- **Hanging up while a call is still connecting actually cancels it** now, rather than dropping you into the call a second later.

### ⚽ Slogaball
- **Bomb pegs.** Hit one and it takes its neighbors with it, in full color.

### 📥 Import from Discord
- **A finished import stops announcing itself** every time you reload, and the notice has an X on it.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-06",
    title: "Patch Notes",
    published_at: "2026-08-06T16:00:00.000Z",
    markdown_content: `## v0.21.0 — Your stickers can come too

### 📥 Import your Discord server's stickers
- **Importing a server from Discord? Your custom stickers can now come across with it.** When an import finishes, we'll offer the extra step: add our importer bot to your Discord server, press **Import stickers**, and they land here — ready to send.
- **The bot only reads stickers.** It asks for zero permissions, and you can kick it the moment the import finishes — it doesn't need to stay.
- Anything we can't bring over (too large, or in a format we can't use) is listed plainly at the end, so the numbers always add up.

### 🎞️ The GIF picker works now
- **Search and send GIFs from the picker in the message bar** — browse the categories or find exactly the right reaction. Powered by GIPHY.

### ⚽ Slogaball
- **Sound effects**, with a mute toggle that remembers what you picked.

### ✍️ A tidier message bar
- **Extra composer actions now tuck behind a chevron** — the dice roller lives in the slide-out tray, and disappearing messages sits next to the emoji button.

### 🖥️ Desktop
- **Start with Windows** is now a proper toggle in Settings, not just the tray menu.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-03",
    title: "Patch Notes",
    published_at: "2026-08-03T20:00:00.000Z",
    markdown_content: `## v0.20.0 — Call transcripts, on your device

### 📝 Transcribe a call
- **A transcribe button in DM, group and voice-channel calls.** A live panel shows who said what as they say it, and when you're done you can copy the text or save it as **.txt** or **.vtt** subtitles.
- **Everything runs on your own device.** The speech model is fetched once and the audio never goes anywhere — it can't: calls are end-to-end encrypted, so there is no server copy to transcribe. Only someone in the call can transcribe it.
- **Everyone in the call is told**, the same way as recording — a banner while it runs, a message in the channel, and a warning for anyone joining mid-way.
- The transcript sticks around after the call ends, so you can still copy or export it once everyone's hung up.
- On the web, Windows desktop and Android. Not on the Linux app just yet.

### 🚪 Sign out, properly
- **Sign out lives in your user menu now** as well as Settings — and both ask you first, so a stray click can't dump you back to the login screen.

### 📅 Events
- **Events with a voice channel show a Join button** — one click puts you in the right channel when it's time, no hunting through the sidebar.

### 📞 Calls
- **Camera tiles fill their card** instead of floating in a letterbox — faces, not bars.
- **Starting a screen share now focuses it for you too**, not just for everyone else watching.
- Fixed a case where an **encrypted call could refuse to connect** for a device that had never messaged the other side — it now sorts itself out instead of failing until a restart.

### 📱 Phones
- **Sideways works now.** Landscape on a phone had been getting a cramped desktop layout — and on iPhones a white strip down the side. Both fixed.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-08-02",
    title: "Patch Notes",
    published_at: "2026-08-02T23:45:00.000Z",
    markdown_content: `## v0.19.0 — Slogaball

### 🎮 Play while you wait
- **Alone in a call?** Waiting for the rest of the group to hop on, or for someone to pick up? A little pill appears: **Play while you wait?** Click it.
- **Slogaball** — aim from the top, drop the ball, watch it bounce. Clear the amber pegs to win, and catch the ball in the sweeping bucket for a free shot. Ten balls a round.
- **Your best score sticks around** — kept on your device and nowhere else. The whole game runs locally; nothing about it ever touches the server.
- **The instant someone joins, it gets out of the way** — it pauses and tucks itself away on its own, no fumbling to close anything mid-hello. Left waiting again? It resumes right where you parked it.
- Mute, deafen and leave stay visible and clickable the whole time — the game never sits over your call controls.
- A nod to a certain peg-and-ball classic people played in raid groups while the last stragglers logged on. If you know, you know.

- On the web now. Reading this in the desktop or Android app? Your version already has it.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-30",
    title: "Patch Notes",
    published_at: "2026-07-30T16:00:00.000Z",
    markdown_content: `## v0.18.0 — Record a call, and give the screen share the whole room

### ⏺️ Record a call
- **A record button in DM, group and voice-channel calls.** Everyone's audio — their mics, their shared screen's sound, and your own — mixed into a single file on your machine.
- **Everyone in the call is told.** A banner runs the whole time, a message lands in the channel, and anyone joining a call already being recorded is warned before they connect. Hide the banner and it collapses to a ⏺ marker that stays put.
- **You choose where the file goes before recording starts**, and it's written as you speak. A crash or a closed laptop leaves a playable file of everything up to that moment instead of nothing.
- **Saved as .m4a**, so it opens in Windows Media Player, VLC, Apple Music, Audacity — anything, without conversion.
- Recording happens on your own machine because it's the only place it can: calls are end-to-end encrypted, so the server never has the audio to record. Only someone in the call can capture it.
- **Server owners get a new "Record Call" permission**, off by default — nobody can record in your voice channels until you say so.
- To be straight with you: this tells you when someone uses **this button**. It can't know about a screen recorder or a phone sitting on the desk — no app can.

### 🖥️ Screen sharing
- **A shared screen now takes the whole call** — everyone else moves into a column down the left instead of a strip across the bottom, so the picture fills the frame properly.
- Shares focus themselves when they start, but only once, and never by dragging you off a share you're already watching.
- Narrow windows, phones and the floating call window keep the layout they had.
- With nobody sharing, the participant grid centers and wraps again instead of running down one edge.

### 💬 Messaging
- **Every message shows its time**, not just the first of a run — and a new **Appearance** setting turns them all off if you'd rather have the clean look.
- **Type \`:D\` and get an emoji.** The usual set — \`:)\` \`:(\` \`:P\` \`;)\` \`<3\` and friends — expands as you type. Times, file paths and code are left alone, ctrl-Z brings back what you typed, and there's a setting to switch it off.
- **\`:D\` used to insert a dice.** The emoji suggestion list was opening on a single letter and Enter picked \`:die:\` instead of sending your message. Fixed.
- **Copy an image**, not just its link — from the attachment menu or the fullscreen viewer, ready to paste straight into another app.

### ✨ Polish
- **Right-clicking Sloga's own chrome** — sidebar padding, the space under the member list, call surfaces — no longer opens your browser's menu over the top. Text boxes keep theirs, and shift+right-click still gets you the browser's.
- **The member list uses the space it's given** instead of being squeezed into the bottom of the channel column.
- **Fixed: a single visit at phone width could hide a server's member list for good**, on desktop too, until you found the button again.
- On phones, the user bar no longer covers the message box, the last row of forum posts, or the bottom of the events calendar.
- Naming an emoji something invalid now says what a valid name looks like, instead of showing you the validator's raw output.

- On the web now; desktop and Android pick these up with their next update.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-29",
    title: "Patch Notes",
    published_at: "2026-07-29T18:00:00.000Z",
    markdown_content: `## v0.17.0 — Encrypted images, and desktop downloads fixed

### 🖥️ Desktop
- **The attachment download button works again** — on the desktop app it had been doing nothing at all. The same fix brings back every link that opens outside Sloga, including **Continue** on a link warning.
- **The new user bar has landed here too** — your avatar and status plus mute, deafen and settings at the bottom of the sidebar, on desktop and Android now as well as the web.

### 🖼️ Encrypted images
- **Encrypted image attachments open in the full image viewer**, the same as any other image — pinch, zoom, and step through them properly instead of squinting at a thumbnail.
- **Save an encrypted image straight from the viewer** when you want to keep it.

### 💬 Messaging
- **Share a server or a group with someone? You can DM them.** No friend request first.
- When a DM can't be opened, Sloga now says why instead of quietly doing nothing.
- On phones, opening a DM slides the drawer out of your way.

### ✨ Polish
- A fresh look for the login screen.
- Horizontal strips — emoji rows, category pickers — keep your swipe instead of handing it to the navigation drawer.
- Server discovery requests tick when you click anywhere on the row, not just on the checkbox itself.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-28",
    title: "Patch Notes",
    published_at: "2026-07-28T16:30:00.000Z",
    markdown_content: `## v0.16.0 — Your voice controls, always at hand

### 🎛️ New user bar
- **A quick-access bar at the bottom of the sidebar** — your avatar and status, plus mute, deafen and settings, always one click away. No more digging into a call to reach them.
- **Mute or deafen before you even join** — the bar works outside calls too, and whatever you set is exactly how you'll enter the next call. No more hot-mic surprises.
- **Switch your microphone or speakers on the fly** — the little arrows next to each toggle open a device picker, with a shortcut straight into Voice Settings.
- Click your avatar in the bar to change your presence or status message.

- On the web now; desktop and Android pick it up with their next update.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-27",
    title: "Patch Notes",
    published_at: "2026-07-27T18:00:00.000Z",
    markdown_content: `## v0.15.0 — Import from Discord & raid loot sheets

### 📦 Import from Discord
- **Recreate your Discord server on Sloga by pasting a server template link** — no bots to add, no logins, no permissions to grant.
- Brings over the **server name, categories, channels, and roles with their permissions** — private channels stay private.
- When it finishes you get an **invite link** ready to share with your community.
- Imports keep running even if you close the app — you'll be notified when it's done.
- Find it under **Add a server → Import from Discord**.

### 🛡️ Soft-reserve raid loot sheets
- **Built-in soft-res for World of Warcraft raids** — post a loot sheet in any channel with the shield button in the message bar (or \`/softres\`) and let raiders reserve their items.
- **Covers 40 raids across Classic, The Burning Crusade and Wrath** with era-accurate loot tables — pick up to four raids per sheet.
- Per-raider and per-item reserve caps, **hard reserves**, and **hidden sheets** where only the raid leader sees who reserved what.
- **Lock a sheet** to freeze reserves — manually, or automatically when a linked server event starts.
- **Attach a sheet to a server event** straight from the Events page.
- **Export to Gargul, RollFor or CSV** for in-game loot rolls.

### ✨ Polish
- Polls in busy channels now load their results reliably.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-26",
    title: "Patch Notes",
    published_at: "2026-07-26T22:30:00.000Z",
    markdown_content: `## v0.14.0 — Attachments up to 5 GB

### 💾 Big file sharing
- **Upload files up to 5 GB** — the old ~95 MB ceiling is gone. Installers, videos, modpacks: if it fits, it ships.
- **Uploads are chunked and resumable** — a dropped connection picks up where it stopped instead of starting over, and the progress bar now shows real progress instead of jumping to 100% and hanging.
- **Re-sending a big file is instant** — the server recognizes files it already has.
- Files over 20 MB are still kept for 24 hours — think transfer, not storage.
- Encrypted DMs keep their 20 MB attachment limit for now — big encrypted files are coming later.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-20",
    title: "Patch Notes",
    published_at: "2026-07-20T20:00:00.000Z",
    markdown_content: `## v0.13.0 — Friends popout, stickers & a tidier mic

### 🪟 Pop out your friends list
- **Detach the friends list into its own window**, Steam-style, so you can keep an eye on who's online while you're playing or working in another app.
- Available on the desktop app — pop it out from the Friends rail entry.

### 🖼️ Sticker fixes
- **Stickers now render inline in chat** instead of showing up as a plain attachment.
- The sticker picker got a **scrollable grid**, so larger packs are actually browsable.

### 🎙️ Cleaner voice settings
- **Mic modes are now mutually exclusive** — Voice Activity, Open Mic and Push-to-Talk behave like proper radio buttons, so you can't end up in two modes at once.

### ✨ Polish
- Removed leftover upstream links from the server and bot creation screens — everything points at Sloga now.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-19",
    title: "Patch Notes",
    published_at: "2026-07-19T20:00:00.000Z",
    markdown_content: `## v0.12.0 — Face filters, server discovery & Sloga Helper

### 🎭 Webcam face filters
- **14 AR face filters** for your camera — classic, viking, gaming and D&D packs.
- Plus a **beautify** slider and a set of **color looks** to grade your video.
- Everything runs on your own device, so it works in encrypted calls too.

### 🧭 Public server discovery
- **Browse a directory of public communities** and join with one click.
- Server owners can **opt their server in** from server settings; listings are admin-approved.

### 🤖 Sloga Helper
- A **first-party bot** you can add from **Server Settings → Apps**, with a curated catalog of official bots.
- First command: **\`/giveaway\`** — run a giveaway in a channel with a button people click to enter, and Sloga Helper picks the winner.

### 📞 Better incoming calls
- **A global Accept / Decline popup** now appears wherever you are in the app.
- Calls **ring from the moment they start**, and desktop notifications are **clickable** — click the toast to jump straight into the call.

### 🔊 Soundboard & GIFs
- **"Sloga Sounds"** — 35 built-in sound clips available in every server, no upload needed.
- The soundboard picker is now a **compact scrollable popover**.
- The GIF picker now runs through **our own proxy**, so no third party sees what you search for.

### 💛 Support Sloga
- Added a **Donate** entry on Home and in Settings, if you'd like to help keep the lights on.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-18",
    title: "Patch Notes",
    published_at: "2026-07-18T20:00:00.000Z",
    markdown_content: `## v0.11.1 — Encryption reliability

### 🔐 Fewer surprises with encrypted DMs
- **Fixed messages going missing** after you re-enabled encryption on a device — Sloga now fetches what it needs up front and reconciles when you open a DM.
- **Clear markers** when a message couldn't be decrypted, instead of a silent gap.
- **Re-enabling encryption now sticks** — sending an encrypted message no longer leaves the conversation showing as plaintext.
- Revoking a device **retries loudly** instead of failing quietly.

### 💾 Save encrypted attachments
- Encrypted images and files now have a **Save button** on desktop that decrypts and writes straight to disk.

### ⏳ No more frozen recovery window
- Creating, rotating or restoring your **recovery key** no longer freezes the app while it works.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-17",
    title: "Patch Notes",
    published_at: "2026-07-17T20:00:00.000Z",
    markdown_content: `## v0.11.0 — Push-to-talk, profiles & a warmer welcome

### 🎙️ Global push-to-talk
- **Push-to-talk now works even when Sloga isn't focused** on desktop — hold your key while you're in a game and talk.

### 👋 A warmer start
- New members are **automatically added to the Sloga welcome server**, so nobody lands in an empty app.
- **Sloga-branded emails** for verification, password reset and account notices.
- An **animated Sloga logo** now plays on the login screen.

### 👤 Profiles & friends
- **Message or call someone you're not friends with** straight from their profile card or context menu — including a video call button.
- **Double-click a friend** in the friends list to open the DM instead of the profile.
- **Friend requests appear instantly** instead of needing a refresh.
- **Staff usernames** render in Sloga's brand colors.

### 🖼️ Animated server icons
- Servers with animated icons now **play them in the server rail**.

### 📱 Floating call card
- Call controls **stay on-screen** in the floating picture-in-picture card, and it now **docks to edge midpoints** as well as corners.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-15",
    title: "Patch Notes",
    published_at: "2026-07-15T20:00:00.000Z",
    markdown_content: `## v0.10.1 — Mobile composer & event attachments

### ⌨️ Two-bar composer on mobile
- The message box on **phones and tablets** is now a two-bar layout — more room to type, and the actions you actually use within thumb reach.
- New **Sloga-styled send button**, and a tidier attachment card.
- Start a **video call or screen share from a DM** via the composer menu.

### 🎲 Dice rolls in calls
- Roll results now **flash over the call video**, so everyone sees the roll without leaving the call.

### 📅 Event attachments
- **Attach files to a calendar event** — maps, rosters, rules, whatever the event needs.

### 🐛 Fixes
- Captions only advertise **broadcast** where it actually works.
- The last row of the member list is no longer flush against the window edge.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-14",
    title: "Patch Notes",
    published_at: "2026-07-14T20:00:00.000Z",
    markdown_content: `## v0.10.0 — Encrypted calls, announcements & soundboard

### 🔐 End-to-end encrypted calls
- **Your voice, video and screen share can now be end-to-end encrypted.** Media is encrypted on your device — the server only ever relays scrambled data it can't read.
- Turn it on with **"Encrypt my calls"** in call settings. Everyone in the call needs a compatible app (desktop or Android); if someone can't encrypt, you'll see a clear notice before anything is sent in the clear.
- A lock indicator on the call shows when a call is fully encrypted.

### 📣 Announcement channels
- **Mark a channel as an announcement channel** — other servers can *follow* it, and every post you make is published to their followed channel automatically.
- Great for release notes, patch notes, and community-wide updates that should reach more than one server.

### 🔊 Server soundboard
- **Play sound clips in a voice channel** for everyone to hear — Discord-style.
- Upload and manage your server's clips in **Server Settings → Soundboard**, then trigger them from the in-call soundboard picker.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-13",
    title: "Patch Notes",
    published_at: "2026-07-13T20:00:00.000Z",
    markdown_content: `## v0.9.0 — Bots, polls, captions & more ways to share

### 🤖 Slash-command bots
- **Interactive bots** are here — type \`/\` in the composer to run a bot command.
- Bots can reply with **buttons, dropdown menus, and pop-up forms**, and can respond **just to you** (ephemeral) when it makes sense.

### 📊 Polls
- **Create a poll right from the composer** — add your options and let people vote.
- Live results update as votes come in.

### ↪️ Forwarding & ⏰ scheduled messages
- **Forward a message** to another channel or DM, keeping its attachments intact.
- **Schedule a message** to send later — write it now, pick a time, and Sloga delivers it for you.

### 💬 Live call captions
- **Real-time subtitles in calls**, translated into your chosen language, appearing under each person's video tile.
- Optional **spoken translation** reads the translated text aloud.
- Encrypted calls are respected — captions are generated on your own device.

### 🎙️ Noise suppression
- **Background noise removal for your mic** (keyboard, fans, room noise) — on by default, with a toggle in **Settings → Voice**.

### 📺 Inline video playback
- Uploaded videos now **play directly in chat** instead of only downloading.

### 🎬 Streamer mode
- **Hide sensitive info while you stream** — your email, invite links, and notification content are tucked away.
- On desktop, Sloga can **auto-detect when OBS or other streaming apps are running** and switch it on for you.

### 🎨 A fresh look
- New **multicolor Sloga logo** across the app.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-12",
    title: "Patch Notes",
    published_at: "2026-07-12T20:00:00.000Z",
    markdown_content: `## v0.8.0 — Threads & Forums

### 🧵 Threads
- **Branch a side conversation off any message** without cluttering the main channel.
- Threads keep focused discussions together and notify only the people taking part.

### 🗂️ Forum channels
- **A new channel type built for topics** — every post is its own thread that people can reply to.
- Perfect for questions, guides, and long-running discussions that deserve their own space.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-10",
    title: "Patch Notes",
    published_at: "2026-07-10T20:00:00.000Z",
    markdown_content: `## v0.7.0 — Events, encrypted DMs & translation

### 📅 Server Events
- **Schedule events in your server** — one-off or repeating, with a title, time, and description.
- **Invite people or entire roles** — everyone can RSVP with Accept or Decline.
- Get **notified** when an event you joined is starting.
- Open the calendar from the top of your server to browse what's coming up.

### 🔐 End-to-end encrypted DMs (native apps)
- **Opt-in E2EE for direct messages** — messages are encrypted on your device and only you and the other person can read them. The server only ever sees scrambled ciphertext.
- Works in **1:1 and group DMs**, including **attachments** — photos and files are encrypted before they leave your device.
- **Safety numbers** let you verify you're really talking to who you think you are.
- **Key backup with a recovery code** — restore your encrypted conversations on a new device.
- Available in the desktop and Android apps. Both sides need E2EE turned on.

### 🌍 Message translation
- New in **Settings → Language**: automatically detect and **translate other people's messages** into the language you choose — in servers and DMs.
- Translations appear right under the original message with a "Translated from …" note.
- Your privacy is respected: **encrypted messages are never sent for translation**.

### 🎲 Dice rolls
- Roll dice right in chat from the composer — rolls are made **by the server**, so results can't be faked.

### 📞 Voice & video calls
- **Switch devices mid-call** — a new button in the call bar lets you swap your microphone, speaker, or camera without leaving the call.
- **Theater mode** — go fullscreen and hit ⤢ to hide everything but the camera or screen-share you're watching; press Escape to come back.
- **Resize the call** — drag the divider on the bottom edge of the call card to balance the video and the chat below it.
- **Calls now work across different networks** — video and screen-share no longer drop after a second when you and a friend aren't on the same network.
- More reliable **screen-sharing** at high resolutions, including for people connecting from outside your network.

### 🖥️ Interface
- The **left sidebar can now expand** — click the arrow to see server and DM names at a glance.
- Dark theme is now the default for new users.

### 🛠️ Fixes & stability
- Fixed a **reconnect loop** after network drops — the app now recovers cleanly when your connection blips.
- Images, videos and downloads now load reliably behind the new sloga.gg address.
- **Large attachments are now cleared automatically** — files over 20MB are removed a day after they're sent to keep things fast and save space. The message text stays; only the big attachment is freed up.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-06",
    title: "Patch Notes",
    published_at: "2026-07-06T02:00:00.000Z",
    markdown_content: `## v0.6.0 — Sloga has a home: sloga.gg 🌐

Sloga now lives at a permanent address: **app.sloga.gg**. No more moving links — bookmark it, share it, it's here to stay.

### 🔑 Sign in with Google
- **One-click login** — hit *Continue with Google* on the login screen. No password needed.
- Already have an account? Signing in with Google using the same email links straight to it.
- Two-factor authentication is still respected — Google sign-in never skips your 2FA.

### 🔄 Automatic updates
- **Desktop**: the app now updates itself — when a new version ships, you'll get a prompt to install and restart. This is the last version you'll ever install by hand.
- **Android**: the app checks for new versions on launch and installs them in-app — no more sideloading every update.

### 🖥️ Desktop
- Fresh installer with the new Sloga look.
- The app now connects through sloga.gg, so it works from anywhere.

*Sloga — Hop on.*`,
  },
  {
    id: "sloga-2026-07-04",
    title: "Patch Notes",
    published_at: "2026-07-04T20:00:00.000Z",
    markdown_content: `## v0.5.0 — We are now Sloga! 🎉

**Acutest is now Sloga** — from the Serbian word for *unity and concord*.

### What's new
- **New name, new logo**: the circle of dots is us — different people, one circle.
- Everything else works exactly as before: your account, messages, friends, and servers are unchanged.

*Sloga — Hop on.*`,
  },
  {
    id: "acutest-2026-07-04",
    title: "Patch Notes",
    published_at: "2026-07-04T12:00:00.000Z",
    markdown_content: `## v0.4.0 — July 4, 2026

### 🔔 Push Notifications
- **You now get notified when the app is closed!** Messages, incoming calls, and friend requests reach you on every platform.
- **Browser**: enable in Settings → Notifications → Enable Push Notifications.
- **Android app**: notifications arrive in the notification bar with sound — messages show the sender and text; **incoming calls ring with your phone's ringtone and Answer/Decline buttons**. Answer drops you straight into the call.
- Android tip: for instant delivery, set Settings → Apps → Sloga → Battery → **Unrestricted**.

### 📢 Patch Notes
- These notes now pop up after updates — check "Don't show this again" to snooze them until the next release.
- Read them anytime in Settings → Patch Notes.

### 🎮 Desktop
- Game detection list now updates from the server — new games are detected without reinstalling the app.

### 📞 Calls
- Added a video call button next to the voice call button.
- Mute and camera states now sync correctly between participants.`,
  },
  {
    id: "acutest-2026-07-03",
    title: "Patch Notes",
    published_at: "2026-07-03T12:00:00.000Z",
    markdown_content: `## July 3, 2026

### ✨ Added
- **Game activity** — the desktop app detects what you're playing and shows "Playing …" to friends, with play time on your profile. Toggle in Settings → Profile.
- **Incoming call ringing** — calls now ring with your chosen ringtone and stop when answered or when the caller hangs up.
- **"Keep me logged in"** checkbox on the login screen.
- **Voice calls keep running in the background** on Android, with an ongoing notification.
- New orange Sloga app icon on Android.
- **Patch notes are now in-app** — this popup! New updates appear here automatically.

### 🐛 Fixed
- Android app login ("Failed to fetch").
- Garbled labels in voice settings.
- Camera brightness slider now works live during calls.
- Voice connection failures ("engine not connected").
- "Playing …" status now clears when you quit the game.`,
  },
  {
    id: "acutest-2026-07-02",
    title: "Patch Notes",
    published_at: "2026-07-02T12:00:00.000Z",
    markdown_content: `## July 2, 2026

### 🎨 New Look
- Sloga theme: orange highlights, cyan accents, near-black background.
- Send button now shows the Sloga logo.

### 🔊 Sounds
- 5 message sounds, 10 ringtones, and 5 disconnect sounds — pick yours in Settings → Notifications.

### 🎙️ Voice
- Microphone gain slider (0–200%).
- Connection quality badge on call tiles.

### 🔐 Channels
- Password-protected channels with a lock icon in the sidebar.

### 🤝 Social
- "Invite a friend" in the server right-click menu.`,
  },
];
