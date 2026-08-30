# PPTX ONLYOFFICE Warmup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the first visible ONLYOFFICE PPTX playback wait without increasing idle server load on the 3.9 GB host, and report ready only after the document is usable.

**Architecture:** Keep static PPTX rendering as the default. Once the user explicitly opens a PPTX preview, request one temporary playback config, preload ONLYOFFICE browser assets, and warm the same stable document key in a hidden editor. The visible player waits for that bounded warmup, reuses only the DocumentServer conversion cache, and then requests a fresh short-lived signed playback config. Centralize ONLYOFFICE browser lifecycle code in one module and use `onDocumentReady`, not `onAppReady`, as the ready boundary.

**Tech Stack:** React 19, TypeScript, ONLYOFFICE Docs API 9.4, Vitest

---

### Task 1: Lock the preload and readiness contracts

**Files:**
- Create: `apps/web/src/components/artifacts/onlyoffice-runtime.test.ts`
- Create: `apps/web/src/components/artifacts/onlyoffice-runtime.ts`

- [x] **Step 1: Write failing tests for preload URL derivation and document-ready events**

```ts
expect(onlyOfficePreloadUrl("https://office.example.test/web-apps/apps/api/documents/api.js"))
  .toBe("https://office.example.test/web-apps/apps/api/documents/preload.html");
expect(Object.keys(onlyOfficeEditorConfig(config, handlers).events)).toEqual([
  "onDocumentReady",
  "onError",
]);
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @kindergarten/web test -- onlyoffice-runtime.test.ts`

Expected: FAIL because `onlyoffice-runtime.ts` does not exist.

- [x] **Step 3: Implement the shared ONLYOFFICE runtime**

Implement these exact responsibilities in `onlyoffice-runtime.ts`:

```ts
export function onlyOfficePreloadUrl(apiUrl: string): string;
export function preloadOnlyOfficeStaticAssets(apiUrl: string): void;
export function loadOnlyOffice(apiUrl: string): Promise<void>;
export function onlyOfficeEditorConfig(
  config: PptxPlaybackResponse["config"],
  events: { onDocumentReady: () => void; onError: () => void },
): Record<string, unknown>;
export function warmOnlyOfficePlayback(value: PptxPlaybackResponse): Promise<void>;
```

Use a hidden official `preload.html` iframe, one script promise per API URL, one warmup promise per `DocumentServer origin + document key` during the current browser page lifecycle, and a 30-second cleanup timeout. Do not start any work until a PPTX preview component mounts.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `pnpm --filter @kindergarten/web test -- onlyoffice-runtime.test.ts`

Expected: PASS.

### Task 2: Warm playback only after the user opens a PPTX preview

**Files:**
- Modify: `apps/web/src/components/artifacts/PptxPreview.tsx`
- Modify: `apps/web/src/components/artifacts/OnlyOfficePptxPlayer.tsx`
- Test: `apps/web/src/product/PublishedArtifactPanel.test.tsx`

- [x] **Step 1: Add the playback preparation boundary**

In `PptxPreview`, keep only the current warmup promise. Start `preloadOnlyOfficeStaticAssets` plus `warmOnlyOfficePlayback` from an effect after the preview mounts, and pass a loader to the visible player that waits for the current warmup before requesting a fresh short-lived signed playback config. Do not restart warmup merely because a parent render creates a new loader function. Swallow warmup failure so the visible player can still use the ordinary cold path.

- [x] **Step 2: Move visible player loading to the shared runtime**

Delete the component-local script map and loader. Build the visible editor configuration with `onlyOfficeEditorConfig`, so `ready` is set only by `onDocumentReady` and errors still expose the existing retry UI.

- [x] **Step 3: Preserve static-preview and download behavior**

Run: `pnpm --filter @kindergarten/web test -- PublishedArtifactPanel.test.tsx onlyoffice-runtime.test.ts`

Expected: PASS, including the existing 32 MiB boundary and PPTX preview rendering assertions.

### Task 3: Verify the bounded fix

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-pptx-onlyoffice-warmup.md`

- [x] **Step 1: Run Web typecheck and all Web tests**

Run: `pnpm --filter @kindergarten/web typecheck && pnpm --filter @kindergarten/web test`

Expected: both commands pass.

- [x] **Step 2: Build the production Web bundle**

Run: `pnpm --filter @kindergarten/web build`

Expected: TypeScript and Vite production build pass.

- [x] **Step 3: Review the diff for scope and resource safety**

Run: `git diff --check && git diff -- apps/web/src/components/artifacts apps/web/src/product/PublishedArtifactPanel.test.tsx docs/superpowers/plans/2026-08-30-pptx-onlyoffice-warmup.md`

Expected: no whitespace errors; no Remote, deployment, authentication, or server-resource changes.
