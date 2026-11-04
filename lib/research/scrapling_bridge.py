"""One-page fetch for the PLUT_OS research studio, run by lib/research/fetch.mjs.

Reads one JSON request on stdin, writes one JSON result on stdout. Nothing else is printed to
stdout, so the caller can parse it whole; Scrapling's own log goes to stderr.

Rules enforced here, per hop (redirects are followed by hand so every hop is checked):
  - http/https only, and the host must resolve to public addresses: no loopback, private,
    link-local, multicast or reserved ranges. Otherwise an AI could read this machine's own
    dashboard, the router, or anything else on the home network.
  - robots.txt is honoured for our user agent.
  - An honest user agent, no browser impersonation, no stealth headers: Scrapling's stealth
    fetcher exists to get past bot protection, which is a site's explicit "no".

With "render": true the page is opened in headless Chromium (Playwright) so its scripts run,
for pages that fill themselves in after loading. The same rules hold: robots.txt for the page
and for where it ends up, the honest user agent, and every request the page makes, including
its scripts' own, is aborted unless its host resolves to public addresses. Images, media and
fonts are not loaded. Content the page still hides after its scripts ran is dropped as before.

A JSON response is returned as indented text, so an API answer can be quoted like a page.

With "mode": "images" the page's images are saved instead of its text: a Steam store data URL
(store.steampowered.com/api/appdetails) gives the header, capsule and screenshots; any other page
gives its social preview images, Steam screenshot links and its img tags. Each image is checked
like a page (public address and robots.txt per host, every redirect hop), must be PNG, JPEG, WebP
or GIF between 8 KB and the size cap, and is written to outDir under its own hash. SVG is never
kept (it can carry scripts).
"""
import glob
import hashlib
import ipaddress
import json
import os
import socket
import sys
import time
from urllib.parse import urljoin, urlsplit

MAX_REDIRECTS = 5


def fail(code, message, **extra):
    print(json.dumps({"ok": False, "code": code, "error": message, **extra}))
    sys.exit(0)


def public_host(parts):
    """True when every address the host resolves to is public; None when it does not resolve."""
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror:
        return None
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global or address.is_multicast:
            return False
    return True


def check_public(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        fail("scheme", f"Only http and https pages can be fetched: {url}")
    verdict = public_host(parts)
    if verdict is None:
        fail("dns", f"Host not found: {parts.hostname}")
    if not verdict:
        fail("private", f"{parts.hostname} resolves to a local or private address; local network pages are never fetched.")


def robots_allows(fetcher, url, user_agent, timeout):
    from protego import Protego
    parts = urlsplit(url)
    robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
    try:
        check_public(robots_url)
        response = fetcher.get(robots_url, timeout=timeout, stealthy_headers=False, impersonate=None,
                               headers={"User-Agent": user_agent}, follow_redirects=True)
    except Exception:
        return True   # unreachable robots.txt: no stated rule to honour
    if response.status >= 400:
        return True
    try:
        return Protego.parse(response.body.decode(response.encoding or "utf-8", "replace")).can_fetch(url, user_agent)
    except Exception:
        return True


def main_markdown(response):
    # Prefer the article/review body over navigation chrome; fall back to the whole page.
    best = ""
    selectors = (
        "#AppHubCards",
        "#ModalContentContainer",
        "#user_reviews_container",
        "article",
        "main",
        "[role=main]",
        "#content",
        "#main",
        ".content",
    )
    for selector in selectors:
        try:
            text = response.markdown(css_selector=selector) or ""
        except Exception:
            text = ""
        if len(text) > len(best):
            best = text
    try:
        full_main = response.markdown(main_content_only=True) or ""
        if len(full_main) > len(best) * 1.5 or len(best) < 400:
            best = full_main
    except Exception:
        pass
    return best


def find_existing_playwright_chromium():
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "",
        os.path.join(os.environ.get("LOCALAPPDATA") or "", "ms-playwright"),
        os.path.expanduser("~/Library/Caches/ms-playwright"),
        os.path.expanduser("~/.cache/ms-playwright"),
    ]
    patterns = [
        "chromium-*/chrome-win*/chrome.exe",
        "chromium_headless_shell-*/chrome-headless-shell-win*/chrome-headless-shell.exe",
        "chromium-*/chrome-linux/chrome",
        "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for pat in patterns:
            matches = sorted(glob.glob(os.path.join(root, pat)), reverse=True)
            for candidate in matches:
                if os.path.isfile(candidate):
                    return candidate
    return None


def launch_browser(pw):
    custom = os.environ.get("PLUTOS_CHROMIUM")
    if custom:
        return pw.chromium.launch(headless=True, executable_path=custom)
    try:
        return pw.chromium.launch(headless=True)
    except Exception as err:
        if "Executable doesn't exist" not in str(err):
            raise
        existing = find_existing_playwright_chromium()
        if existing:
            try:
                return pw.chromium.launch(headless=True, executable_path=existing)
            except Exception:
                pass
        for channel in ("chrome", "msedge"):
            try:
                return pw.chromium.launch(headless=True, channel=channel)
            except Exception:
                continue
        raise err


def render(url, user_agent, timeout):
    """Open the page in headless Chromium; returns (status, final_url, html, content_type)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("missing", "Rendering needs Playwright. Run: pip install playwright, then: playwright install chromium")
    verdicts = {}

    def allowed(request_url):
        parts = urlsplit(request_url)
        if parts.scheme in ("data", "blob", "about"):
            return True
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return False
        if parts.hostname not in verdicts:
            verdicts[parts.hostname] = public_host(parts) is True
        return verdicts[parts.hostname]

    def route(r):
        if r.request.resource_type in ("image", "media", "font") or not allowed(r.request.url):
            r.abort()
        else:
            r.continue_()

    try:
        with sync_playwright() as pw:
            browser = launch_browser(pw)
            try:
                context = browser.new_context(user_agent=user_agent, service_workers="block")
                context.add_cookies([
                    {"name": "birthtime", "value": "631152001", "domain": ".steampowered.com", "path": "/"},
                    {"name": "wants_mature_content", "value": "1", "domain": ".steampowered.com", "path": "/"},
                    {"name": "mature_content", "value": "1", "domain": ".steampowered.com", "path": "/"},
                    {"name": "lastagecheckage", "value": "1-January-1990", "domain": ".steampowered.com", "path": "/"},
                    {"name": "birthtime", "value": "631152001", "domain": ".steamcommunity.com", "path": "/"},
                    {"name": "wants_mature_content", "value": "1", "domain": ".steamcommunity.com", "path": "/"},
                ])
                context.route("**/*", route)
                page = context.new_page()
                response = page.goto(url, timeout=timeout * 1000, wait_until="domcontentloaded")
                try:
                    page.wait_for_load_state("networkidle", timeout=min(10, timeout) * 1000)
                except Exception:
                    pass   # a page that keeps polling never goes idle; take what has rendered
                return (response.status if response else 0, page.url, page.content(),
                        (response.headers.get("content-type", "") if response else ""))
            finally:
                browser.close()
    except Exception as error:
        if "Executable doesn't exist" in str(error):
            fail("missing", "Playwright's Chromium is not installed. Run: playwright install chromium")
        fail("network", f"Could not render {url}: {str(error).splitlines()[0]}")


def json_text(body, encoding):
    try:
        return json.dumps(json.loads(body.decode(encoding or "utf-8", "replace")), indent=1, ensure_ascii=False)
    except (ValueError, UnicodeDecodeError):
        return None


MIN_IMAGE_BYTES = 8_000   # below this it is an icon, a badge or a tracking pixel
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def get_checked(fetcher, url, user_agent, timeout, robots_cache, headers=None):
    """GET with every redirect hop checked: public address and robots.txt per host."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        check_public(current)
        host = urlsplit(current).netloc
        if host not in robots_cache:
            robots_cache[host] = robots_allows(fetcher, current, user_agent, timeout)
        if not robots_cache[host]:
            raise PermissionError(f"robots.txt asks automated readers not to fetch {current}.")
        response = fetcher.get(current, timeout=timeout, stealthy_headers=False, impersonate=None,
                               headers={"User-Agent": user_agent, **(headers or {})}, follow_redirects=False)
        if response.status in (301, 302, 303, 307, 308):
            location = (response.headers or {}).get("location") or (response.headers or {}).get("Location")
            if not location:
                raise ValueError(f"Redirect without a location from {current}.")
            current = urljoin(current, location)
            continue
        return response, current
    raise ValueError(f"More than {MAX_REDIRECTS} redirects from {url}.")


def image_candidates(response, page_url, body_text):
    """Image URLs a page offers, best first: Steam's store data, then social preview, then large images."""
    found = []
    if "json" in str((response.headers or {}).get("content-type", "")):
        # Steam's store data (api/appdetails): {"<appid>": {"data": {header_image, screenshots, …}}}
        try:
            data = json.loads(body_text)
            for entry in data.values():
                app = (entry or {}).get("data") or {}
                found += [app.get("header_image"), app.get("capsule_image")]
                found += [shot.get("path_full") for shot in app.get("screenshots", [])]
        except Exception:
            pass
        return [u for u in found if u]
    try:
        found += response.css('meta[property="og:image"]::attr(content)').getall()
        found += response.css('meta[name="twitter:image"]::attr(content)').getall()
        found += response.css("a.highlight_screenshot_link::attr(href)").getall()
        for srcset in response.css("img::attr(srcset)").getall():
            parts = [p.strip().split(" ")[0] for p in srcset.split(",") if p.strip()]
            if parts:
                found.append(parts[-1])
        found += response.css("img::attr(src)").getall()
    except Exception:
        pass
    return found


def fetch_images(fetcher, request, user_agent, timeout):
    url = str(request.get("url", ""))
    out_dir = str(request.get("outDir", ""))
    max_images = max(1, min(int(request.get("maxImages", 12)), 30))
    max_bytes = max(10_000, min(int(request.get("maxBytes", 5_000_000)), 15_000_000))
    if not out_dir or not os.path.isdir(out_dir):
        fail("input", "No folder to save images in.")
    robots_cache = {}
    try:
        page, page_url = get_checked(fetcher, url, user_agent, timeout, robots_cache)
    except PermissionError as error:
        fail("robots", str(error))
    except Exception as error:
        fail("network", f"Could not fetch {url}: {error}")
    if page.status >= 400:
        fail("status", f"{page_url} answered HTTP {page.status}.", status=page.status)
    body_text = page.body.decode(page.encoding or "utf-8", "replace") if isinstance(page.body, bytes) else str(page.body or "")
    seen, candidates = set(), []
    for raw in image_candidates(page, page_url, body_text):
        full = urljoin(page_url, str(raw).strip())
        parts = urlsplit(full)
        if parts.scheme not in ("http", "https") or full in seen or parts.path.lower().endswith(".svg"):
            continue
        seen.add(full)
        candidates.append(full)
    saved, skipped, last_host = [], [], None
    for image_url in candidates:
        if len(saved) >= max_images:
            break
        host = urlsplit(image_url).netloc
        if host == last_host:
            time.sleep(0.5)   # a polite pace inside one host; the page itself already waited
        last_host = host
        try:
            response, final = get_checked(fetcher, image_url, user_agent, timeout, robots_cache)
        except Exception as error:
            skipped.append({"url": image_url, "reason": str(error)[:200]})
            continue
        kind = str((response.headers or {}).get("content-type", "")).split(";")[0].strip().lower()
        body = response.body if isinstance(response.body, bytes) else bytes(response.body or b"")
        if response.status >= 400:
            skipped.append({"url": image_url, "reason": f"HTTP {response.status}"}); continue
        if kind not in IMAGE_TYPES:
            skipped.append({"url": image_url, "reason": f"not an image type we keep ({kind or 'unknown'})"}); continue
        if len(body) > max_bytes:
            skipped.append({"url": image_url, "reason": f"larger than {max_bytes} bytes"}); continue
        if len(body) < MIN_IMAGE_BYTES:
            skipped.append({"url": image_url, "reason": "too small to be content (icon or tracker)"}); continue
        digest = hashlib.sha256(body).hexdigest()
        name = f"{digest[:16]}.{IMAGE_TYPES[kind]}"
        with open(os.path.join(out_dir, name), "wb") as handle:
            handle.write(body)
        saved.append({"url": image_url, "finalUrl": final, "file": name, "bytes": len(body), "type": kind, "sha256": digest})
    print(json.dumps({"ok": True, "finalUrl": page_url, "images": saved, "skipped": skipped[:40],
                      "candidates": len(candidates)}))


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        fail("input", "Malformed request.")
    url = str(request.get("url", ""))
    timeout = int(request.get("timeout", 25))
    user_agent = str(request.get("userAgent", "PLUT_OS-research"))
    max_chars = int(request.get("maxChars", 200_000))
    # Before Scrapling is imported, so the refusal of this machine and the home network holds, and is testable,
    # even where Scrapling is missing (cleanup plan P1-11).
    check_public(url)
    try:
        from scrapling.fetchers import Fetcher
    except ImportError:
        fail("missing", "Scrapling is not installed. Run: pip install \"scrapling[fetchers]\" markdownify")

    if request.get("mode") == "images":
        fetch_images(Fetcher, request, user_agent, timeout)
        return

    if not robots_allows(Fetcher, url, user_agent, timeout):
        fail("robots", f"robots.txt asks automated readers not to fetch {url}.")

    if request.get("render"):
        from scrapling.engines.toolbelt.custom import Response
        status, current, html, content_type = render(url, user_agent, timeout)
        check_public(current)
        if current != url and not robots_allows(Fetcher, current, user_agent, timeout):
            fail("robots", f"robots.txt asks automated readers not to fetch {current}.")
        if status >= 400:
            fail("status", f"{current} answered HTTP {status}.", status=status)
        response = Response(url=current, content=html, status=status, reason="", cookies={},
                            headers={"content-type": content_type}, request_headers={}, _log=False)
        emit(response, current, content_type, main_markdown(response), max_chars)
        return

    current = url
    for _ in range(MAX_REDIRECTS + 1):
        check_public(current)
        try:
            response = Fetcher.get(current, timeout=timeout, stealthy_headers=False, impersonate=None,
                                   headers={"User-Agent": user_agent, "Cookie": "birthtime=0; wants_mature_content=1; lastagecheckage=1-0-1990"},
                                   follow_redirects=False)
        except Exception as error:
            fail("network", f"Could not fetch {current}: {error}")
        if response.status in (301, 302, 303, 307, 308):
            location = (response.headers or {}).get("location") or (response.headers or {}).get("Location")
            if not location:
                fail("redirect", f"Redirect without a location from {current}.")
            current = urljoin(current, location)
            continue
        break
    else:
        fail("redirect", f"More than {MAX_REDIRECTS} redirects from {url}.")

    content_type = str((response.headers or {}).get("content-type", ""))
    if response.status >= 400:
        fail("status", f"{current} answered HTTP {response.status}.", status=response.status)
    if "json" in content_type:
        text = json_text(response.body, response.encoding)
        if text is None:
            fail("type", f"{current} says it is JSON but does not parse.")
        emit(None, current, content_type, text, max_chars, status=response.status)
        return
    if content_type and "html" not in content_type and "text" not in content_type:
        fail("type", f"{current} is {content_type}, not a readable page.")
    emit(response, current, content_type, main_markdown(response), max_chars)


def emit(response, current, content_type, markdown, max_chars, status=None):
    try:
        title = (response.css("title::text").get() or "").strip() if response is not None else ""
    except Exception:
        title = ""
    print(json.dumps({"ok": True, "status": status if status is not None else response.status, "finalUrl": current,
                      "title": title[:300], "contentType": content_type[:100], "markdown": markdown[:max_chars],
                      "truncated": len(markdown) > max_chars}))


if __name__ == "__main__":
    main()
