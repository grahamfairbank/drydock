# Security

Read this before exposing Drydock to anything other than a network you fully trust.

## What Drydock can do

Drydock is given the Docker socket. Access to that socket is equivalent to **root on the
host**: whoever controls it can start a privileged container, mount the host's filesystem
and do anything. This is inherent to any tool that manages Docker, and it means:

> Anyone who can sign in to Drydock can take full control of the host.

The console makes this easy on purpose. It offers a shell in every container, lets you
create containers with arbitrary bind mounts, and builds and runs code from uploaded
archives and Git repositories. Treat the Drydock password as you would the host's root
password.

Drydock also has **read access to the whole projects root**. If that is your home
directory, it includes SSH keys, `.env` files and anything else stored there. Drydock only
reads compose files and Dockerfiles from it, and passes project directories to Docker as
build contexts, but a person with console access can read those files through a container.

## What protects it

| Measure | Detail |
|---|---|
| Sign-in | One account, set with `DRYDOCK_USER` and `DRYDOCK_PASSWORD`. Drydock will not start without a password. Credentials are compared in constant time, and a failed attempt is delayed by 1.5 seconds. |
| Sessions | A random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie. Sessions expire after 12 idle hours and are held in memory only. |
| Cross-site requests | Every state-changing request must carry a custom header, which a browser will not send cross-origin without permission the server never grants. The console WebSocket checks that `Origin` matches `Host`. |
| Framing | Pages are served with `X-Frame-Options: DENY`. |
| Path handling | Project paths from requests are resolved and must fall under the projects root or the imports store. Export and upload names are reduced to a base name. Archives are unpacked with Python's `data` filter, which rejects absolute paths, parent-directory escapes and special files. |
| Self-protection | Drydock refuses to stop, suspend, kill, rename, delete or revert its own container. |
| Secrets on screen | Environment values with secret-looking names are masked until clicked. |

## What does not protect it

Be clear about the gaps.

- **No TLS.** The built-in server speaks plain HTTP. On an untrusted network the password
  and session cookie can be read in transit.
- **No lockout.** Failed sign-ins are slowed, not blocked. A weak password can be guessed.
- **One account, one role.** There are no read-only users and no per-user audit beyond the
  initiator shown on each task.
- **Bundles are sensitive.** An exported bundle contains the container's environment
  variables and volume data. Anyone who obtains the file has those secrets.
- **Imports run code.** Importing a project, a bundle or a Git repository builds and runs
  whatever it contains, with whatever privileges its configuration requests. Import only
  what you would be willing to run by hand.

## Recommended deployment

1. **Use a long, random password** and keep `.env` readable only by you
   (`chmod 600 .env`). `./set-password.sh --generate` creates and applies one.
2. **Keep the port off the internet.** Do not forward it on your router.
3. **Add TLS** with a reverse proxy when anyone else shares the network, and publish
   Drydock on loopback so the proxy is the only way in. See
   [Installation](installation.md#running-behind-a-reverse-proxy).
4. **Narrow the projects root** to a directory that holds only projects, rather than a
   whole home directory, if other files there matter.
5. **Reach it remotely through a VPN** such as WireGuard or Tailscale rather than by
   opening the port.
6. **Store bundles as you would backups containing secrets**, and delete them from the
   exports store when they are no longer needed.

## Reporting a vulnerability

Please report security problems privately through GitHub's *Report a vulnerability* button
on the repository's Security tab, rather than in a public issue.
