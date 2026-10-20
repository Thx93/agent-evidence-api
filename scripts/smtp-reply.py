#!/usr/bin/env python3
"""
Send a reply to an inbound email by direct-to-MX SMTP over IPv4.

There is no sendmail, no ESP account, and no mail credentials on this host. What does
work, and what this reproduces, is connecting straight to the recipient's MX over port
25 and forcing IPv4: the IPv6 path is rejected by Gmail ("does not meet IPv6 sending
guidelines regarding PTR records"), and sending from an SPF-less disposable domain is
rejected outright.

Deliverability is therefore limited by the sending identity, not by this code. A reply
to a personal Gmail/Workspace address generally lands; Zoho and Cloudflare MX reject
unauthenticated senders.

Usage:
  python3 scripts/smtp-reply.py --to a@b.com --subject "..." --body-file /tmp/b.txt
  python3 scripts/smtp-reply.py --to a@b.com --subject "..." --body-file /tmp/b.txt --dry
"""
import argparse
import smtplib
import socket
import ssl
import sys
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

SENDER_ADDRESS = "outreach@agent-evidence-api.thx93.workers.dev"
SENDER_NAME = "Agent Evidence API"
EHLO_NAME = "agent-evidence-api.thx93.workers.dev"


def mx_hosts(domain: str) -> list[str]:
    """MX hostnames for a domain, lowest priority first, via DNS over HTTPS.

    DoH rather than a resolver call so this works in a sandbox with no resolv.conf
    access. Cloudflare's resolver is used because it answers plain JSON.
    """
    import json
    import urllib.request

    url = f"https://cloudflare-dns.com/dns-query?name={domain}&type=MX"
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        data = json.load(res)
    answers = [a for a in data.get("Answer", []) if a.get("type") == 15]
    hosts = []
    for a in answers:
        parts = a["data"].split()
        if len(parts) == 2:
            hosts.append((int(parts[0]), parts[1].rstrip(".")))
    return [h for _, h in sorted(hosts)]


def ipv4_of(host: str) -> str | None:
    """The first A record for a host, or None. IPv4 is required: see the module note."""
    import json
    import urllib.request

    url = f"https://cloudflare-dns.com/dns-query?name={host}&type=A"
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=20) as res:
        data = json.load(res)
    for a in data.get("Answer", []):
        if a.get("type") == 1:
            return a["data"]
    return None


def build(to: str, subject: str, body: str, in_reply_to: str | None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f"{SENDER_NAME} <{SENDER_ADDRESS}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="agent-evidence-api.thx93.workers.dev")
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(body)
    return msg


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body-file", required=True)
    ap.add_argument("--in-reply-to", default=None)
    ap.add_argument("--dry", action="store_true", help="connect and EHLO, then quit")
    args = ap.parse_args()

    body = open(args.body_file, encoding="utf-8").read()
    domain = args.to.split("@", 1)[1]
    hosts = mx_hosts(domain)
    if not hosts:
        print(f"  ✖ no MX for {domain}")
        return 1
    print(f"  MX {domain}: {', '.join(hosts[:3])}")

    last = None
    for host in hosts[:3]:
        ip = ipv4_of(host)
        if not ip:
            print(f"  · {host}: no A record, skipping")
            continue
        print(f"  → {host} [{ip}]:25")
        try:
            smtp = smtplib.SMTP(timeout=30)
            smtp.connect(ip, 25)
            code, msg = smtp.ehlo(EHLO_NAME)
            print(f"    EHLO {code}")
            if args.dry:
                smtp.quit()
                print("    dry run: connected and quit without sending")
                return 0
            message = build(args.to, args.subject, body, args.in_reply_to)
            refused = smtp.send_message(message, from_addr=SENDER_ADDRESS, to_addrs=[args.to])
            smtp.quit()
            if refused:
                print(f"    ✖ refused: {refused}")
                last = "refused"
                continue
            print(f"    ✓ accepted by {host} for {args.to}")
            return 0
        except (smtplib.SMTPException, OSError, ssl.SSLError) as err:
            print(f"    ✖ {type(err).__name__}: {str(err)[:110]}")
            last = err
            time.sleep(2)
    print(f"  ✖ all MX attempts failed ({last})")
    return 1


if __name__ == "__main__":
    sys.exit(main())
