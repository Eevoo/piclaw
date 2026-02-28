IMAGE ?= pibox
TAG ?= latest
FULL_IMAGE := $(IMAGE):$(TAG)
REGISTRY ?= ghcr.io
GHCR_OWNER ?= $(shell whoami)
GHCR_IMAGE := $(REGISTRY)/$(GHCR_OWNER)/$(IMAGE):$(TAG)

.PHONY: help up down enter build build-piclaw lint test test-coverage dual-tag tag-ghcr sync-version bump-patch push

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Start the container in detached mode
	docker-compose up -d

down: ## Stop and remove the container
	docker-compose down

enter: ## Enter the running container as agent
	docker exec -u agent -it pibox bash

build: ## Build Docker image
	docker build -t $(FULL_IMAGE) .

build-piclaw: ## Build piclaw dist + web assets
	cd piclaw && bun run build && bun run build:web

lint: ## Lint piclaw sources
	cd piclaw && bun run lint

test: ## Run piclaw tests
	cd piclaw && bun run test

test-coverage: ## Run piclaw tests with coverage
	cd piclaw && bun run test:coverage

dual-tag: build ## Tag image as ghcr.io/<user>/<image>:<tag>
	docker tag $(FULL_IMAGE) $(GHCR_IMAGE)

tag-ghcr: dual-tag ## Convenience alias for dual-tag

sync-version: ## Sync piclaw/package.json version with VERSION
	@set -e; \
	VERSION=$$(cat VERSION); \
	tmp=$$(mktemp); \
	jq --arg version "$$VERSION" '.version=$$version' piclaw/package.json > $$tmp; \
	mv $$tmp piclaw/package.json; \
	echo "Synced piclaw/package.json to version $$VERSION"

bump-patch: ## Bump patch version and create git tag
	@OLD=$$(cat VERSION); \
	MAJOR=$$(echo $$OLD | cut -d. -f1); \
	MINOR=$$(echo $$OLD | cut -d. -f2); \
	PATCH=$$(echo $$OLD | cut -d. -f3); \
	NEW="$$MAJOR.$$MINOR.$$((PATCH + 1))"; \
	echo $$NEW > VERSION; \
	$(MAKE) sync-version; \
	$(MAKE) build-piclaw; \
	git add VERSION piclaw/package.json piclaw/dist piclaw/web/static/js; \
	git commit -m "Bump version to $$NEW"; \
	git tag "v$$NEW"; \
	echo "Bumped version: $$OLD -> $$NEW (tagged v$$NEW)"

push: ## Push commits and current tag to origin
	@TAG=$$(git describe --tags --exact-match 2>/dev/null); \
	git push origin main; \
	if [ -n "$$TAG" ]; then \
		echo "Pushing tag $$TAG..."; \
		git push origin "$$TAG"; \
	else \
		echo "No tag on current commit"; \
	fi
