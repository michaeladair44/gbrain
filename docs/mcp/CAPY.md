# Connect GBrain to Capy

[Capy](https://capy.ai) is a cloud coding-agent platform, and its agents run on machines in Capy's cloud. To give one memory from a brain you host yourself, join Capy's machines to your tailnet and bridge them to a tailnet-only GBrain over a STDIO MCP server. Nothing here needs Funnel or any public exposure. The access is a scoped `memory-writer` machine client from the [private handoff path](../guides/hosted-harness-access.md#1-grant-access-on-the-brain-host); Capy has no GBrain-specific adapter, so the grant uses the `generic` harness.

> **Status.** This page records a working setup observed on 2026-10-22. The connection, a search and the identity check were observed in a Capy thread. Unattended token renewal at expiry was **not** observed yet; see [What is verified](#what-is-verified). Capy's own settings move, so treat its screens as approximate and check its docs: [MCP servers](https://docs.capy.ai/integrations/mcp) and [Tailscale](https://docs.capy.ai/integrations/tailscale).

> New to this? The [Give your coding agent a memory](../tutorials/connect-coding-agent.md)
> tutorial walks both paths (local-from-nothing and connect-to-an-existing-brain)
> end to end, plus the brain-first protocol that makes it worth it. This page is
> the connection reference.

## Why a bridge

Capy's Streamable HTTP MCP servers need a public HTTPS URL, and a tailnet-only brain is not one. For a private server, Capy's documented route is to connect its Tailscale integration and add a **STDIO** server that runs a bridge such as [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Capy's OAuth does not apply to STDIO servers, so the bridge authenticates to GBrain itself with a machine client's `client_credentials`, and the credentials live in the Capy server's **Variables**, which Capy encrypts.

This is the "cloud agent whose runtime you can join to your tailnet" row of [Who reaches what](../guides/remote-mcp.md#who-reaches-what). Cloud agents that cannot join your tailnet still need `gbrain mcp expose --funnel`.

## 1. Publish the brain on your tailnet

On the brain host, use the default tailnet-only publication (or your own `tailscale serve`). Steps, flags and troubleshooting: [Use your brain from anywhere over MCP](../guides/remote-mcp.md).

```bash
gbrain mcp expose
```

The printed MCP URL looks like `https://your-machine.your-tailnet.ts.net/mcp`. Do not pass `--funnel`.

## 2. Let Capy machines join the tailnet

In Capy, open **Settings → Integrations → Tailscale** and connect a Tailscale OAuth client scoped to **Keys → Auth Keys → Write** for `tag:capy`, then enable the integration for the project. Capy machines then join your tailnet as ephemeral nodes tagged `tag:capy`. Follow Capy's [Tailscale page](https://docs.capy.ai/integrations/tailscale) for the current screens.

## 3. Limit what `tag:capy` can reach

Edit the tailnet policy so the tag exists and can reach only the MCP port on the brain host. The relevant fragments:

```json
{
  "tagOwners": {
    "tag:capy": ["autogroup:admin"]
  },
  "grants": [
    {
      "src": ["tag:capy"],
      "dst": ["your-machine"],
      "ip":  ["tcp:443"]
    }
  ],
  "tests": [
    {
      "src": "tag:capy",
      "accept": ["your-machine:443"],
      "deny": ["your-machine:22"]
    }
  ]
}
```

Replace `your-machine` with the host alias in your policy and `443` with the port your published URL uses (a URL without a port means 443). Keep your existing grant for your own devices on `autogroup:member`; adding the tag must not remove it. The `tests` block makes the policy editor reject a change that lets `tag:capy` reach anything but the MCP port.

## 4. Pin the hostname on Capy machines

In the verified setup, Capy's ephemeral nodes did not resolve MagicDNS names. If the MCP URL fails to resolve, pin the name to the brain host's tailnet IP with a Capy Setup **startup entry** (run on every boot):

```bash
grep -q ' your-machine.your-tailnet.ts.net$' /etc/hosts || echo '100.x.y.z your-machine.your-tailnet.ts.net' | sudo tee -a /etc/hosts
```

`100.x.y.z` is the brain host's tailnet IP (`tailscale ip -4` on the host). The `grep` guard keeps repeated boots from appending duplicate lines. A tailnet IP changes if the host's node is replaced, so update the entry then.

## 5. Grant access on the brain host

Give Capy its own principal with the narrowest profile that does the job. Preview first:

```bash
gbrain mcp grant capy --harness generic --profile memory-writer \
  --source default --skills memory-only --token-ttl 86400 \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --admin-token-file ~/.gbrain/serve/admin-token \
  --credentials-out /absolute/private/capy.json --json --dry-run
```

Then run the same command without `--dry-run`. `--skills memory-only` opts the client out of shared-skill enrollment, and `--token-ttl 86400` makes new access tokens last 24 hours (the `generic` adapter's default is 1 hour, and the server caps any lifetime at 90 days; see [access-token lifetime](ADMIN.md#access-token-lifetime)). Transfer `capy.json` to the person who configures Capy over a private channel; it holds the client secret. For profiles, sources and shared skills, see [hosted harness access](../guides/hosted-harness-access.md#1-grant-access-on-the-brain-host).

Check the server side:

```bash
gbrain mcp verify --client CLIENT_ID --harness generic \
  --url https://your-machine.your-tailnet.ts.net/mcp \
  --credentials-file /absolute/private/capy.json --json
```

Expect `server_status: "passed"` and an overall `status: "partial"` (exit code 2). `partial` is correct here: it means harness evidence is still missing until you check from inside Capy ([Verify](#verify)).

## 6. Install the bridge in Capy Setup

Add these to the project's Capy Setup so every machine has the bridge and a credentials file made only of placeholders. The bridge reads the real values from the server's Variables at run time, so the client secret never lands in that file or on a command line.

```bash
npm install --prefix "$HOME/.local/share/mcp-remote" --ignore-scripts mcp-remote@0.15.2
printf '%s\n' '{"client_id":"${GBRAIN_CLIENT_ID}","client_secret":"${GBRAIN_CLIENT_SECRET}"}' \
  > "$HOME/.local/share/mcp-remote/gbrain-client.json"
```

Pin `mcp-remote` to `0.15.2`. That release provides `--client-credentials` and `--static-oauth-client-info`, and expands `${ENV}` placeholders in the file you pass with `@file`. Other versions have not been checked against this setup.

## 7. Add the MCP server in Capy

In Capy, open **Settings → MCP & plugins** and add a **STDIO** server:

| Field | Value |
| --- | --- |
| Command | `node` |
| Arguments | `/absolute/path/to/.local/share/mcp-remote/node_modules/mcp-remote/dist/proxy.js`, `https://your-machine.your-tailnet.ts.net/mcp`, `--client-credentials`, `--static-oauth-client-info`, `@/absolute/path/to/.local/share/mcp-remote/gbrain-client.json` |
| Variables | `GBRAIN_CLIENT_ID` and `GBRAIN_CLIENT_SECRET`, copied from the handoff |

Use the absolute paths of the files Setup created on the Capy machine, one entry per argument. The client information goes in through `@file` because a JSON object typed into the arguments field is split at its commas, and because it keeps the secret out of the command line.

The server's **Test** button can report *Unavailable*: Capy's tester is not on your tailnet, so it cannot reach the brain. That is not a failure of the connection; check from inside a thread.

## Verify

Start a Capy thread in a project with the Tailscale integration enabled and the server on, then ask the agent:

```
Call whoami, then search my brain for [topic].
```

`whoami` should report `client_name` `capy` and the `memory-writer` profile, and the search should return rows. Use `whoami` for identity here, not `get_brain_identity`. To go further, run the memory round trip in [prove a memory round trip](../guides/hosted-harness-access.md#3-prove-a-memory-round-trip) from a Capy thread, then recall the fact from a new thread.

## Tokens and renewal

The bridge asks GBrain for a new access token with its `client_credentials` when it needs one, so you do not renew tokens by hand. Only the short-lived access token is cached on the Capy machine, under `~/.mcp-auth`; the client secret stays in the server's Variables. Treat both as secrets. If an access token is exposed, follow [invalidate tokens](ADMIN.md#invalidate-tokens-revoke-or-delete); the client can obtain a new one afterward, so revoke the client instead when access should end.

## Rotate the client secret

On the brain host:

```bash
gbrain agent register --reissue CLIENT_ID
```

`--reissue` is the local operator path for confidential `client_credentials` clients ([limits](ADMIN.md#recover-a-failed-step)). It rotates the secret but leaves outstanding access tokens valid until they expire, so preview and apply [`gbrain mcp admin invalidate-tokens CLIENT_ID`](ADMIN.md#invalidate-tokens-revoke-or-delete) afterward, then update `GBRAIN_CLIENT_SECRET` in the Capy server's Variables. Keep the private output of the rotation; the old delivery journal no longer matches.

## Remove

Order matters, because an active machine client gets new tokens after `invalidate-tokens`.

1. On the brain host, revoke the client, then invalidate its tokens, previewing each before you apply it ([commands](ADMIN.md#invalidate-tokens-revoke-or-delete)): `gbrain mcp admin revoke CLIENT_ID`, then `gbrain mcp admin invalidate-tokens CLIENT_ID`.
2. In Capy, remove the STDIO server in **Settings → MCP & plugins**.
3. In Capy, turn off the project in **Settings → Integrations → Tailscale**. Remove the Setup entries (the hosts pin and the bridge install) if you no longer need them.
4. Optionally delete the `tag:capy` grant from your tailnet policy.

Removing Capy-side configuration alone does not revoke server access, and revoking a client does not delete brain memory.

## What is verified

Observed on 2026-10-22:

- Capy machines joined the tailnet as `tag:capy` ephemeral nodes and reached the MCP port under the policy above.
- `gbrain mcp verify` passed its server checks (`server_status: "passed"`, overall `partial`).
- In a Capy thread, `whoami` showed `client_name` `capy` with the profile, and a search returned rows.
- Without the hosts pin, MagicDNS names did not resolve on Capy's ephemeral nodes, and the pin fixed it.

Not yet observed:

- **Unattended renewal when the access token expires.** The bridge is expected to renew with `client_credentials`, but as of 2026-10-22 no token had expired during an observed session. Until you see it, check a Capy thread after the first 24 hours (or your `--token-ttl`).
- Whether the bridge picks up a new token after `invalidate-tokens` while an old one is still cached in `~/.mcp-auth`.
- Versions of `mcp-remote` other than `0.15.2`.

## Notes

- One grant per independent harness. Do not reuse the Capy credentials in another tool; give it its own client.
- The credentials belong to the machine client, not to a person. Keep the profile at `memory-writer` and the source narrow, because whoever can use the Capy server can act as that client.
