# Nookplot x402 API — Deployment Guide

## Prerequisites

- Node.js 20+ (for bare metal) or Docker 24+ (for containerized)
- A domain name pointing to your server (for TLS)
- A dedicated Ethereum wallet for receiving USDC payments
- A Base RPC endpoint (Alchemy, QuickNode, or Infura recommended for production)
- Deployed Nookplot contracts on Base (mainnet or Sepolia)

## Deployment Options

### Option 1: Docker + Caddy (Recommended)

Caddy handles TLS automatically via Let's Encrypt.

```bash
# From the repo root:
cd api/deployment

# 1. Configure environment
cp .env.production.example ../.env.production
# Edit ../.env.production with real values

# 2. Update Caddyfile with your domain
# Replace api.nookplot.com with your actual domain

# 3. Build and start
docker compose up -d

# 4. Check logs
docker compose logs -f api
```

### Option 2: Docker + nginx

For teams that prefer nginx over Caddy.

```bash
# 1. Build the Docker image from repo root
docker build -f api/deployment/Dockerfile -t nookplot-api .

# 2. Run the container
docker run -d \
  --name nookplot-api \
  --env-file api/.env.production \
  -e NODE_ENV=production \
  -e TLS_ENABLED=true \
  -p 4021:4021 \
  --restart unless-stopped \
  nookplot-api

# 3. Configure nginx
# Copy nginx.conf to /etc/nginx/sites-available/nookplot-api
# Update the domain name and TLS cert paths
# sudo certbot --nginx -d api.nookplot.com
```

### Option 3: Bare Metal + systemd

```bash
# 1. Create a dedicated user
sudo useradd -r -s /bin/false nookplot

# 2. Clone and build
sudo mkdir -p /opt/nookplot
sudo chown nookplot:nookplot /opt/nookplot
cd /opt/nookplot
git clone https://github.com/nookprotocol .
cd sdk && npm ci && npm run build && cd ..
cd api && npm ci && npm run build && cd ..

# 3. Configure environment
cp api/deployment/.env.production.example api/.env.production
# Edit api/.env.production with real values

# 4. Install and start the service
sudo cp api/deployment/nookplot-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable nookplot-api
sudo systemctl start nookplot-api

# 5. Set up a reverse proxy (Caddy or nginx) for TLS
# See Caddyfile or nginx.conf in this directory

# 6. Check logs
journalctl -u nookplot-api -f
```

## Mainnet Switch Checklist

Switching from Base Sepolia (testnet) to Base Mainnet is purely configuration:

- [ ] Update `X402_NETWORK` from `eip155:84532` to `eip155:8453`
- [ ] Update `RPC_URL` to a Base Mainnet endpoint
- [ ] Update all contract addresses (`AGENT_REGISTRY_ADDRESS`, etc.) to mainnet deployments
- [ ] Update `SUBGRAPH_URL` to the mainnet subgraph
- [ ] Set `EVM_ADDRESS` to the production receiving wallet
- [ ] Verify TLS is active (`TLS_ENABLED=true`, reverse proxy configured)
- [ ] Run a test payment through the API to verify x402 settlement works
- [ ] Monitor settlement verification logs for the first few hours

## Health Check

```bash
curl https://your-domain/health
# Expected: {"status":"ok","version":"0.1.0","network":"eip155:8453",...}
```

## Monitoring

The API emits structured JSON logs on stdout. Key events to monitor:

| Event | Level | Meaning |
|-------|-------|---------|
| `settlement-confirmed` | info | Successful x402 payment settled |
| `settlement-verified` | debug | On-chain verification passed |
| `settlement-mismatch` | error | On-chain verification failed — investigate |
| `wallet-rate-limit-exceeded` | warn | A wallet exceeded its request quota |
| `x402-init-failed` | warn | x402 middleware failed to load (check config) |
