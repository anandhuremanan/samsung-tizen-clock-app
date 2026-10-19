"""Create a Samsung TV author + distributor certificate without Tizen Studio.

Does the same steps as Samsung's Certificate Manager add-on:
  1. Sign in to a Samsung account in the browser (callback on localhost:4794).
  2. Generate RSA keys and CSRs locally (the distributor CSR lists the TVs' DUIDs).
  3. Ask Samsung's certificate server to sign them.
  4. Bundle each key + certificate + Samsung CA into a .p12 for the tizen CLI.

The sign-in token is kept in memory only and never printed or written.

usage: python make_samsung_cert.py <DUID> [<DUID> ...] [--out DIR]
"""
import argparse
import io
import json
import os
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNIN_URL = ("https://account.samsung.com/mobile/account/check.do?serviceID=v285zxnl3h"
              "&actionID=StartOAuth2&accessToken=Y&redirect_uri=http://localhost:4794/signin/callback")
AUTHOR_URL = "https://svdca.samsungqbe.com/apis/v3/authors"
DISTRIBUTOR_URL = "https://svdca.samsungqbe.com/apis/v3/distributors"
# Samsung's official certificate extension; the TV CA certificates live inside it
CERT_EXTENSION_URL = "https://download.tizen.org/sdk/extensions/tizen-certificate-extension_2.0.75.zip"
AUTHOR_CA = "vd_tizen_dev_author_ca.cer"
DISTRIBUTOR_CA = "vd_tizen_dev_public2.crt"
SIGNIN_TIMEOUT_S = 600

session = {}
done = threading.Event()


class CallbackHandler(BaseHTTPRequestHandler):
    def _handle(self, raw):
        fields = dict(urllib.parse.parse_qsl(raw))
        payload = fields.get("code", raw)
        try:
            data = json.loads(payload)
        except ValueError:
            data = fields
        token = data.get("access_token") or data.get("accessToken")
        user_id = data.get("userId") or data.get("user_id")
        if token and user_id:
            session.update(token=token, user_id=user_id,
                           email=data.get("inputEmailID") or data.get("email") or "")
            body = "<h2>Signed in. You can close this tab and go back to the terminal.</h2>"
            done.set()
        else:
            print("Callback arrived without a token. Fields received:", sorted(data.keys()))
            body = "<h2>Sign-in did not return a token. Check the terminal.</h2>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self._handle(self.rfile.read(length).decode("utf-8", "replace"))

    def do_GET(self):
        self._handle(urllib.parse.urlparse(self.path).query)

    def log_message(self, *args):
        pass


def ensure_ca_certs(ca_dir):
    """Download Samsung's TV CA certificates from the official extension if missing."""
    wanted = [AUTHOR_CA, DISTRIBUTOR_CA]
    if all(os.path.exists(os.path.join(ca_dir, n)) for n in wanted):
        return
    print("Downloading Samsung CA certificates from download.tizen.org (~45 MB, one time)...", flush=True)
    try:
        with urllib.request.urlopen(CERT_EXTENSION_URL, timeout=300) as resp:
            outer = zipfile.ZipFile(io.BytesIO(resp.read()))
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f"Could not download {CERT_EXTENSION_URL} ({e}).\n"
                 f"Try again later, or copy {AUTHOR_CA} and {DISTRIBUTOR_CA} from a Tizen Studio\n"
                 f"install with the Samsung Certificate Extension into a folder and pass --ca-dir.")
    addon = zipfile.ZipFile(io.BytesIO(outer.read("binary/cert-add-on_2.0.75_windows-64.zip")))
    jar_name = next(n for n in addon.namelist()
                    if n.startswith("data/tools/certificate-manager/plugins/org.tizen.common.cert_"))
    jar = zipfile.ZipFile(io.BytesIO(addon.read(jar_name)))
    os.makedirs(ca_dir, exist_ok=True)
    for name in wanted:
        with open(os.path.join(ca_dir, name), "wb") as f:
            f.write(jar.read("res/ca/" + name))


def make_csr(common_name, email, duids=None):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, common_name)]
    if email:
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, email))
    builder = x509.CertificateSigningRequestBuilder().subject_name(x509.Name(attrs))
    if duids:
        names = [x509.UniformResourceIdentifier("URN:tizen:packageid=")]
        names += [x509.UniformResourceIdentifier("URN:tizen:deviceid=" + d) for d in duids]
        builder = builder.add_extension(x509.SubjectAlternativeName(names), critical=False)
    csr = builder.sign(key, hashes.SHA512())
    return key, csr.public_bytes(serialization.Encoding.PEM)


def post_csr(url, fields, csr_pem, filename):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="csr"; filename="{filename}"\r\n'
                 f'Content-Type: application/octet-stream\r\n\r\n'.encode() + csr_pem + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(url, data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"Samsung server refused {filename}: HTTP {e.code} {e.read()[:500]!r}")


def load_cert(data, out_dir, label="response"):
    try:
        return x509.load_pem_x509_certificate(data)
    except ValueError:
        pass
    try:
        return x509.load_der_x509_certificate(data)
    except ValueError:
        dump = os.path.join(out_dir, label + ".raw")
        with open(dump, "wb") as f:
            f.write(data)
        sys.exit(f"Could not parse the {label} from Samsung; saved it to {dump}")


def write_p12(path, key, cert, ca_path, password):
    with open(ca_path, "rb") as f:
        ca = load_cert(f.read(), os.path.dirname(path), "ca")
    # The Java bundled with the Tizen CLI cannot read AES-encrypted PKCS#12,
    # so use the older 3DES / SHA-1 scheme it expects
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                  .kdf_rounds(2048)
                  .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1())
                  .build(password.encode()))
    blob = pkcs12.serialize_key_and_certificates(b"usercertificate", key, cert, [ca], encryption)
    with open(path, "wb") as f:
        f.write(blob)


def main():
    parser = argparse.ArgumentParser(description="Create a Samsung TV developer certificate.")
    parser.add_argument("duids", nargs="+", help="DUID of each TV the app should install on")
    parser.add_argument("--out", default=os.path.join(REPO_DIR, "certs"),
                        help="where to write author.p12, distributor.p12 and password.txt")
    parser.add_argument("--ca-dir", help="folder holding Samsung's CA files (default: <out>/ca, "
                                         "downloaded automatically when missing)")
    args = parser.parse_args()
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    ca_dir = os.path.abspath(args.ca_dir) if args.ca_dir else os.path.join(out_dir, "ca")
    ensure_ca_certs(ca_dir)

    server = HTTPServer(("127.0.0.1", 4794), CallbackHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("Opening Samsung sign-in in your browser...")
    print("If it does not open, or you signed in with Google and nothing happened,")
    print("open this link again in the same browser:\n" + SIGNIN_URL, flush=True)
    webbrowser.open(SIGNIN_URL)
    if not done.wait(SIGNIN_TIMEOUT_S):
        server.shutdown()
        sys.exit("Timed out waiting for Samsung sign-in.")
    server.shutdown()
    print("Signed in to Samsung account.", flush=True)

    base = {"access_token": session["token"], "user_id": session["user_id"], "platform": "VD"}

    author_key, author_csr = make_csr("TVClock", session["email"])
    author_cert = load_cert(post_csr(AUTHOR_URL, base, author_csr, "author.csr"), out_dir, "author")
    print("Author certificate issued:", author_cert.subject.rfc4514_string(), flush=True)

    dist_key, dist_csr = make_csr("TizenSDK", session["email"], args.duids)
    dist_fields = dict(base, privilege_level="Public", developer_type="Individual")
    dist_cert = load_cert(post_csr(DISTRIBUTOR_URL, dist_fields, dist_csr, "distributor.csr"),
                          out_dir, "distributor")
    print("Distributor certificate issued for", ", ".join(args.duids), flush=True)

    password = secrets.token_urlsafe(18)
    write_p12(os.path.join(out_dir, "author.p12"), author_key, author_cert,
              os.path.join(ca_dir, AUTHOR_CA), password)
    write_p12(os.path.join(out_dir, "distributor.p12"), dist_key, dist_cert,
              os.path.join(ca_dir, DISTRIBUTOR_CA), password)
    with open(os.path.join(out_dir, "password.txt"), "w") as f:
        f.write(password)
    print("Wrote author.p12, distributor.p12 and password.txt to", out_dir)


if __name__ == "__main__":
    main()
