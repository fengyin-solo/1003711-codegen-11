.PHONY: install frontend build selftest

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

selftest:
	cd frontend && npm run selftest
