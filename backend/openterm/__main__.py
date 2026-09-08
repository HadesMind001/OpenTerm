from __future__ import annotations

import argparse
import logging

import uvicorn

from .api.app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="openterm", description="OpenTerm server")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="bind address. KEEP 127.0.0.1 unless you know exactly what you are "
             "doing: the API has NO auth — order placement, key overwriting and "
             "local script execution are all unauthenticated on any reachable interface.",
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default=None, help="SQLite database path")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        # The old --dev flag promised "CORS open" and did literally nothing;
        # real cross-origin dev needs real protection decisions, so the flag
        # is gone rather than kept as a lie.
        logging.getLogger("openterm").warning(
            "Binding to %s exposes an UNAUTHENTICATED trading + key-management "
            "API to the network. There is no auth layer to turn on.",
            args.host,
        )
    app = create_app(db_path=args.db, with_providers=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
