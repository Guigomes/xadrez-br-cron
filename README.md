# cron-import

Worker diário que sincroniza torneios do **chess-results.com** para o Supabase do
chess-viewer. Executa como um **Cloud Run Job** disparado pelo **Cloud Scheduler**.

## Como funciona

1. Lê todas as linhas de `tournament_imports` com `enabled = true`.
2. Para cada linha:
   - Faz parse da `base_url` (espera-se uma URL `tnr<id>.aspx` do chess-results).
   - Resolve/cria o `pairing_group` correspondente quando `pairing_group_name`
     está preenchido.
   - Acessa `art=5` (lista de inscritos) → encontra o link "Excel" na página → baixa
     o arquivo → faz upsert dos jogadores.
   - Acessa `art=1` (classificação) para descobrir o número de rodadas publicadas.
   - Para cada rodada `1..N`, acessa `art=2&rd=N`, baixa o Excel e atualiza
     `pairings` e o status da rodada.
   - Acessa `art=1` novamente, baixa o Excel e atualiza `standings`.
   - Roda `recalculate_standings(tournament_id)` para recalcular Buchholz, etc.
3. Grava `last_run_at` / `last_status` / `last_message` em cada linha de
   `tournament_imports`.

O processo termina com exit code 0 mesmo quando alguma linha falha — falhas
ficam registradas por linha. Apenas erros fatais (ex: Supabase inacessível)
encerram com código não-zero.

## Variáveis de ambiente

| Variável                     | Descrição                                                          |
|------------------------------|--------------------------------------------------------------------|
| `SUPABASE_URL`               | URL do projeto Supabase                                            |
| `SUPABASE_SERVICE_ROLE_KEY`  | Chave service-role (ignora RLS — necessária para upserts globais) |

## Desenvolvimento local

```sh
cd cron-import
cp .env.example .env       # preencha as variáveis
npm install
npm run dev                # roda src/index.ts via tsx
```

## Build e deploy no Google Cloud

### 1. Build da imagem com Cloud Build

```sh
gcloud builds submit \
  --tag southamerica-east1-docker.pkg.dev/<PROJECT_ID>/cron-import/cron-import:latest \
  ./cron-import
```

> Se ainda não existe, crie o repositório do Artifact Registry:
> ```sh
> gcloud artifacts repositories create cron-import \
>   --repository-format=docker \
>   --location=southamerica-east1
> ```

### 2. Cloud Run Job

```sh
gcloud run jobs create chess-viewer-cron-import \
  --image=southamerica-east1-docker.pkg.dev/<PROJECT_ID>/cron-import/cron-import:latest \
  --region=southamerica-east1 \
  --task-timeout=30m \
  --max-retries=1 \
  --set-env-vars=SUPABASE_URL=https://your-project.supabase.co \
  --set-secrets=SUPABASE_SERVICE_ROLE_KEY=supabase-service-role:latest
```

> Crie o secret antes:
> ```sh
> echo -n "<service_role_key>" | gcloud secrets create supabase-service-role --data-file=-
> ```

Para atualizar a imagem em deploys subsequentes:

```sh
gcloud run jobs update chess-viewer-cron-import \
  --image=southamerica-east1-docker.pkg.dev/<PROJECT_ID>/cron-import/cron-import:latest \
  --region=southamerica-east1
```

### 3. Cloud Scheduler (disparo diário)

```sh
gcloud scheduler jobs create http chess-viewer-cron-import-trigger \
  --location=southamerica-east1 \
  --schedule="0 6 * * *" \
  --time-zone="America/Sao_Paulo" \
  --uri="https://southamerica-east1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/<PROJECT_ID>/jobs/chess-viewer-cron-import:run" \
  --http-method=POST \
  --oauth-service-account-email=<SCHEDULER_SA>@<PROJECT_ID>.iam.gserviceaccount.com
```

> A service account do Scheduler precisa do papel `roles/run.invoker` no Job.

### 4. Execução manual (testar)

```sh
gcloud run jobs execute chess-viewer-cron-import --region=southamerica-east1
```

Logs ficam disponíveis em Cloud Logging com filtro
`resource.type="cloud_run_job"`.

## Observações

- A descoberta do link Excel usa cheerio. Caso o chess-results altere o markup,
  ajuste `findExcelLink` em `src/chess-results.ts`. Há um fallback automático
  para `?prt=4&excel=2010`.
- A correspondência de jogadores entre o Excel e o banco usa `initial_ranking`
  (a coluna "Nº" do chess-results). Se o admin adicionar jogadores manualmente
  com `initial_ranking` divergente, eles serão considerados não pareados.
- Para torneios com múltiplos grupos de emparceiramento (SNode diferentes),
  cadastre uma linha em `tournament_imports` por grupo, com URLs distintas
  (`SNode=S0`, `SNode=S1`, etc.) e o respectivo `pairing_group_name`.
