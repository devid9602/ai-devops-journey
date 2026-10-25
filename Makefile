.PHONY: install test synth diff deploy-dev destroy-dev bootstrap oidc app-test

install:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi

test: ## unit + assertion tests for the CDK stacks, then the sample app
	npm run build && npm test && $(MAKE) app-test

app-test:
	cd app && npm test

synth: ## synthesize both environments
	npm run synth:dev && npm run synth:prod

diff:
	npm run diff:dev

deploy-dev:
	npm run deploy:dev

destroy-dev:
	npx cdk destroy --all -c env=dev --force

bootstrap: ## one-time per account/region: make bootstrap ACCOUNT=123456789012 REGION=us-east-1
	npx cdk bootstrap aws://$(ACCOUNT)/$(REGION)

oidc: ## one-time: create the GitHub OIDC deploy role: make oidc REPO=devid9602/ecs-fargate-platform
	npx cdk deploy ecs-platform-github-oidc -c githubRepo=$(REPO)
