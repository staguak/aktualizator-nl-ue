# Aktualizator prawa NL i UE

Otwarty kod aktualizatora oficjalnych źródeł prawa niderlandzkiego i unijnego.
Program zapisuje teksty, oryginalne źródła, raporty i historię wydań na własnym
Google Drive użytkownika. Publiczne repozytorium zawiera kod i publiczną konfigurację zakresu. Nie zawiera konta Drive ani danych autora.

Możesz korzystać z programu lokalnie albo utworzyć **publiczny fork** i uruchamiać
go ręcznie przez GitHub Actions. Standardowy runner `ubuntu-24.04` w publicznym
repo jest bezpłatny według zasad GitHub. Nie jest to obietnica braku wszystkich
limitów: obowiązują m.in. limit czasu zadania (6 godzin), współbieżność, ograniczenia
API źródeł oraz pojemność Google Drive. Płatne większe runnery nie są potrzebne.
Wyniki nie są przechowywane jako GitHub Artifacts.

## Uruchomienie w GitHub Actions

1. Utwórz publiczny fork tego repozytorium. Włącz Actions, jeśli GitHub o to poprosi.
2. W Google Cloud utwórz własny projekt, włącz Drive API i przygotuj klienta OAuth
   oraz refresh token z **jedynym** zakresem `https://www.googleapis.com/auth/drive.file`.
   Instrukcja: [OAUTH.md](OAUTH.md). Dla trwałego korzystania ustaw
   odpowiedni status aplikacji OAuth; token aplikacji pozostającej w trybie
   testowym może wygasnąć po 7 dniach.
3. W repo utwórz środowisko **`updater`**. Zezwól mu na gałąź **`main`**.
   Zalecany jest wymagany recenzent: właściciel repo. Dodaj sekret środowiska
   **`GOOGLE_DRIVE_OAUTH_JSON`**:

   ```json
   {"client_id":"YOUR_CLIENT_ID","client_secret":"YOUR_CLIENT_SECRET","refresh_token":"YOUR_REFRESH_TOKEN"}
   ```

   Rzeczywistego JSON nie zapisuj w repo ani w zgłoszeniach.
4. Wybierz konfigurację. Pliki w `aktualizator-ph/config/` stanowią mały przykład:
   23 akty NL i 65 pozycji UE. Dostosuj je do własnego zakresu.
   W `release-consumers.json` potwierdź sposób odczytu (`approved: true` oraz
   `verified: true`). Nie potwierdzaj go, jeśli używasz czytnika o innym kontrakcie.
   Konfiguracja może pozostać prywatna: [CONFIGURATION.md](CONFIGURATION.md).
5. Otwórz Actions → **Aktualizator prawa NL i UE** → Run workflow, gałąź `main`.
   Pierwsze uruchomienie: `operation: initialize`, `approve_mutation: true`.
   Kolejne: `operation: update`, `approve_mutation: true`.
   Domyślne `check` sprawdza istniejące wydanie bez publikacji. Przed pierwszym
   `initialize` zakończy się błędem braku instalacji — to oczekiwane.
6. Na Drive znajdź folder `Aktualizator-production`, otwórz `active.json` i przejdź
   przez zapisany w nim `openFolder`. Czytaj NL i UE z **tego samego wydania**.
   Nazwa namespace może być zmieniona zmienną repo `LAW_RELEASE_NAMESPACE`;
   wtedy musi zgadzać się z `release-consumers.json`.

Pierwsza inicjalizacja buduje również bazę początkową i może być długa.
Jeśli zadanie zostanie przerwane, powtórz tę samą operację z tą samą konfiguracją,
datą końcową i rewizją kodu. Program sprawdza trwały dziennik przed wznowieniem.
Nie zmieniaj ręcznie plików roboczych ani wskaźnika aktywnego wydania.

**Harmonogram nie jest skonfigurowany ani aktywny.** Program obsługuje zdarzenie
`schedule`; jego świadome włączenie opisuje [SCHEDULE.md](SCHEDULE.md).
Ręczne uruchamianie pozostaje dostępne niezależnie od harmonogramu.

## Uruchomienie lokalne

Wymagane: Node **24** (wersja przypięta w `.node-version`), CPython **3.12**.
Przypięte koła walidatora Python obsługują Linux x86_64; na innym systemie użyj
zgodnego środowiska Linux. Program nie deklaruje zgodności z każdym systemem.

```sh
cd aktualizator-ph
npm ci
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/xml-requirements.txt -r scripts/rdf-requirements.txt
```

Ustaw `GOOGLE_DRIVE_OAUTH_JSON` w środowisku procesu bez wypisywania go w terminalu.
Skopiuj pliki `config/` do prywatnego katalogu, zmień zakres i potwierdź kontrakt
czytelnika w `release-consumers.json`. Przykładowe polecenia:

```sh
npm run plan -- --operation=initialize --approve-mutation --config-dir=/path/to/private-config
npm run run -- --operation=initialize --approve-mutation --config-dir=/path/to/private-config
npm run run -- --operation=update --approve-mutation --config-dir=/path/to/private-config
npm run run -- --operation=check --config-dir=/path/to/private-config
```

`--range-to=YYYY-MM-DD` ustala datę końcową, a `--full-source-audit` wymusza ponowne
pobranie treści źródeł. `--plan` nie uwierzytelnia i nie zapisuje na Drive.
Konfiguracja domyślna leży w `config/`; `--config-dir` wskazuje inny katalog.
Lokalne logi i wyniki są prywatnymi plikami roboczymi i są wyłączone z Git.

`rollback` i `recover` wymagają `--target-release-id=UUID` oraz zatwierdzenia.
`recover` dodatkowo wymaga dokładnego `--expected-active-sha256=HASH` lub
`missing`, wyłącznie po potwierdzeniu braku `active.json`. Nie zgaduj tych wartości.
Po udanej zmianie program wykonuje osobne pełne sprawdzenie bajtów wydania.

## Testy i ograniczenia

```sh
npm run typecheck
npm run typecheck:tools
npm run parser:selftest
npm test
npm run test:xml
npm run test:evidence
python3 -m unittest discover -s tests -p test_public_distribution.py
```

Testy kodu nie wymagają poświadczeń ani dostępu do prywatnych materiałów.
Workflow **Verify public updater code** uruchamia je na push/PR bez sekretów Drive.
Konfiguracja przykładowa nie jest obietnicą kompletnego korpusu prawa.
Ostrzeżenia o brakującym opcjonalnym Formex lub węższych metadanych RDF są
zachowane w raportach; nie zastępuje się ich pozornym wynikiem pełnej kompletności.
Walidacja struktury nie potwierdza interpretacji ani obowiązywania przepisów.

Kod: [MIT](../LICENSE), z wyjątkami i oznaczeniami w [NOTICE](../NOTICE) i
[THIRD_PARTY.md](../THIRD_PARTY.md). Uwagi i propozycje zmian: issues oraz pull requests.
Zasady poświadczeń i uruchomień: [SECURITY.md](../SECURITY.md).

Zasady GitHub: [rozliczanie Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
i [limity](https://docs.github.com/en/actions/reference/limits).
