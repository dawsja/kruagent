"use client";

import { useEffect, useState } from "react";
import { BotAvatar } from "@/components/hq/bot-avatar";
import { ModelPicker, type ModelPickerOption } from "@/components/hq/model-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BOTS } from "@/lib/hq/bots/registry";

type Settings = {
  enabled?: boolean;
  model?: string | null;
  autoPush?: boolean;
  issuesEnabled?: boolean;
  issueLabel?: string;
  missingPermissions?: string[];
  githubApp?: { slug: string; installationId: number | null } | null;
  error?: string;
};

/** What a refused permission is called on GitHub's permissions page. */
const PERMISSION_NAMES: Record<string, string> = {
  checks: "Checks: Read-only",
  pull_requests: "Pull requests: Read and write",
  issues: "Issues: Read and write",
};

/**
 * The Bots card in Settings: the switch the onboarding step also sets, the
 * auto-push switch for follow-ups, and the lineup so the names on the board
 * mean something. When GitHub refused a read the app isn't allowed, this is
 * also where the fix is explained.
 */
export function BotsSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [autoPush, setAutoPush] = useState(false);
  const [issuesEnabled, setIssuesEnabled] = useState(false);
  const [issueLabel, setIssueLabel] = useState("kru");
  // What's typed in the label box; saved on blur or Enter.
  const [labelDraft, setLabelDraft] = useState("kru");
  const [missing, setMissing] = useState<string[]>([]);
  const [app, setApp] = useState<Settings["githubApp"]>(null);
  const [options, setOptions] = useState<ModelPickerOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(data: Settings | null) {
    setEnabled(Boolean(data?.enabled));
    setModel(data?.model ?? null);
    setAutoPush(Boolean(data?.autoPush));
    setIssuesEnabled(Boolean(data?.issuesEnabled));
    setIssueLabel(data?.issueLabel ?? "kru");
    setLabelDraft(data?.issueLabel ?? "kru");
    setMissing(data?.missingPermissions ?? []);
    setApp(data?.githubApp ?? null);
  }

  useEffect(() => {
    void fetch("/api/bots")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Settings | null) => apply(data))
      .catch(() => setEnabled(false));
    // The same list the board's picker shows, Claude Code included when signed in.
    void fetch("/api/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { options?: ModelPickerOption[] } | null) => setOptions(data?.options ?? []))
      .catch(() => undefined);
  }, []);

  async function save(patch: {
    enabled?: boolean;
    model?: string | null;
    autoPush?: boolean;
    issuesEnabled?: boolean;
    issueLabel?: string;
    recheckPermissions?: true;
  }) {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/bots", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json().catch(() => ({}))) as Settings;
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Could not save");
      setLabelDraft(issueLabel);
      return;
    }
    apply(data);
  }

  function saveLabel() {
    const next = labelDraft.trim();
    if (next === issueLabel) return;
    void save({ issueLabel: next });
  }

  const on = enabled === true;
  const permissionsUrl = app?.slug ? `https://github.com/settings/apps/${encodeURIComponent(app.slug)}/permissions` : "https://github.com/settings/apps";
  const installationUrl = app?.installationId ? `https://github.com/settings/installations/${app.installationId}` : "https://github.com/settings/installations";

  return (
    <Card className="bg-paper-white ring-fog">
      <CardHeader>
        <CardTitle className="text-[16px] tracking-[-0.32px]">Automated bots</CardTitle>
        <CardDescription className="text-[14px] leading-6 text-graphite">
          The crew picks up every card you drop and works it through build, test, review and
          write-up. You only approve the pull request. Turning it on picks up every open card in
          Drop.
        </CardDescription>
        <CardAction>
          <Badge variant="outline" className={on ? "border-mint/40 text-mint" : "text-ash"}>
            {enabled === null ? "…" : on ? "On" : "Off"}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="bots-enabled">Let the crew pick up cards</FieldLabel>
            <FieldDescription>
              Also answers you in the Team chat on the board. Card work uses each card&apos;s model;
              chat uses your default model.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="bots-enabled"
            checked={on}
            disabled={enabled === null || saving}
            onCheckedChange={(next) => void save({ enabled: next })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="bots-auto-push">Let the crew push follow-ups to its own PRs</FieldLabel>
            <FieldDescription>
              After a review comment or a failing check on a pull request Kru opened, the crew builds
              the fix on that pull request&apos;s branch. With this on, it pushes the commit as soon as
              Bibi is done; off, the follow-up waits in Review for you. New pull requests always wait
              for your approval. You can also ask Pip: &ldquo;turn on auto push&rdquo;.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="bots-auto-push"
            checked={autoPush}
            disabled={enabled === null || saving}
            onCheckedChange={(next) => void save({ autoPush: next })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="bots-issues">Pick up labelled issues</FieldLabel>
            <FieldDescription>
              Open GitHub issues carrying the label below become cards in Drop, checked every minute,
              and the crew works them like any card. Their pull requests close the issue when merged,
              and Kru comments on the issue when one opens.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="bots-issues"
            checked={issuesEnabled}
            disabled={enabled === null || saving}
            onCheckedChange={(next) => void save({ issuesEnabled: next })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="bots-issue-label">Issue label</FieldLabel>
          <Input
            id="bots-issue-label"
            value={labelDraft}
            maxLength={50}
            disabled={enabled === null || saving}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={saveLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveLabel();
              }
            }}
            className="max-w-xs"
          />
        </Field>
        {missing.length ? (
          <Alert>
            <AlertTitle>The GitHub App needs more permissions</AlertTitle>
            <AlertDescription>
              <p>
                Kru&apos;s app lacks {missing.map((p) => PERMISSION_NAMES[p] ?? p).join(" and ")}, so{" "}
                {missing
                  .map((p) =>
                    p === "checks"
                      ? "CI results on the crew's pull requests aren't read"
                      : p === "issues"
                        ? "labelled issues aren't picked up"
                        : "some feedback isn't read",
                  )
                  .join(" and ")}{" "}
                until it is granted. Add it on the app&apos;s{" "}
                <a href={permissionsUrl} target="_blank" rel="noreferrer">
                  permissions page
                </a>{" "}
                and save, then accept the new permissions on the{" "}
                <a href={installationUrl} target="_blank" rel="noreferrer">
                  installation
                </a>
                . If it still fails afterwards, reconnect GitHub above.
              </p>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save({ recheckPermissions: true })}
                className="rounded-full border border-fog px-3 py-1 text-[12px] font-medium text-carbon disabled:opacity-50"
              >
                Check again
              </button>
            </AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor="bots-model">Chat model</FieldLabel>
          <FieldDescription>
            What the crew answers with in the Team chat. Claude Code drives the same tools through a
            session in the box. Leave it unset for the first endpoint, or Claude Code when nothing else is
            connected.
          </FieldDescription>
          <ModelPicker
            models={options}
            value={model ?? undefined}
            onValueChange={(value) => void save({ model: value })}
            placeholder="Default"
            emptyHint="Add an API endpoint or sign in to Claude Code."
            triggerLabel="Select the crew's chat model"
            matchTriggerWidth
            side="bottom"
            align="start"
            className="w-full"
          />
        </Field>
        {error ? <p className="text-[13px] text-ember">{error}</p> : null}
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="The crew">
          {BOTS.map((bot) => (
            <li key={bot.id} className="flex items-center gap-3 rounded-xl border border-fog p-3">
              <BotAvatar bot={bot} size={44} />
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-carbon">
                  {bot.name} <span className="font-normal text-ash">· {bot.role}</span>
                </p>
                <p className="text-[12px] leading-5 text-graphite">{bot.tagline}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
