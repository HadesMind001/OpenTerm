# OpenTerm dev workflow. Backend + Vite + Electron on Linux/macOS.
# `make install` then `make dev` (desktop shell) or `make serve` (single-process prod-style).

.PHONY: install dev serve build test test-frontend clean backend kill-ports

PY := .venv/bin/python
LOG_DIR := /tmp/openterm-dev

install:
	python3 -m venv .venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e "backend[dev]"
	cd frontend && npm install

# Nukes whatever is listening on our dev ports. Tries TERM first, KILL only
# after a grace period — SIGKILL on uvicorn mid-write can corrupt the SQLite WAL.
kill-ports:
	@for port in 8000 5173 5174 5175 5176 5177 5178 5179 5180; do \
		pid=$$(lsof -ti:$$port 2>/dev/null); \
		if [ -n "$$pid" ]; then \
			echo "Killing process $$pid on port $$port"; \
			kill $$pid 2>/dev/null || true; \
			sleep 0.3; \
			kill -9 $$pid 2>/dev/null || true; \
		fi; \
	done

# Wait for HTTP endpoint to respond with 2xx/3xx (60s max)
wait-for-http = @echo "Waiting for $(1)..."; \
	n=0; \
	until curl -sf $(1) >/dev/null 2>&1; do \
		n=$$((n+1)); \
		if [ $$n -gt 120 ]; then echo "TIMEOUT waiting for $(1)"; exit 1; fi; \
		sleep 0.5; \
	done; \
	echo "$(1) is ready"

dev: kill-ports
	@mkdir -p $(LOG_DIR)
	@echo "Starting backend on http://localhost:8000 (log: $(LOG_DIR)/backend.log)..."
	@$(PY) -m openterm --port 8000 --db $${HOME}/.local/share/openterm/openterm.db > $(LOG_DIR)/backend.log 2>&1 &
	$(call wait-for-http,http://127.0.0.1:8000/api/watchlist)
	@echo "Starting Vite dev server on http://localhost:5173 (log: $(LOG_DIR)/vite.log)..."
	@cd frontend && VITE_DEV_SERVER_URL=http://localhost:5173 npm run dev > $(LOG_DIR)/vite.log 2>&1 &
	$(call wait-for-http,http://127.0.0.1:5173)
	@echo "All services up: backend :8000, vite :5173. Starting Electron..."
	@cd frontend && VITE_DEV_SERVER_URL=http://localhost:5173 npx electron dist-electron/main.js; \
	rc=$$?; \
	$(MAKE) --no-print-directory kill-ports; \
	exit $$rc

serve: build
	$(PY) -m openterm --port 8765 --db $${HOME}/.local/share/openterm/openterm.db

backend:
	$(PY) -m openterm --port 8000 --db $${HOME}/.local/share/openterm/openterm.db

build:
	cd frontend && npm run build

test:
	$(PY) -m pytest backend/tests -q

test-frontend:
	cd frontend && npm test

clean:
	rm -rf frontend/dist frontend/dist-electron frontend/node_modules/.vite
	find backend bot-runtime/src -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -path ./.venv -prune -o -name '*.pyc' -print -delete 2>/dev/null | true
