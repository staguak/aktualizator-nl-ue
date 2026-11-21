# Kontynuacja publicznego aktualizatora NL i UE

## Punkt startu

- Repozytorium `staguak/aktualizator-nl-ue`, [gałąź robocza](https://github.com/staguak/aktualizator-nl-ue/tree/codex/verification-public-updater-20261119) i [roboczy PR #24](https://github.com/staguak/aktualizator-nl-ue/pull/24).
- PPP Ostatni zweryfikowany commit **kodu aplikacji** to `8b8ad37d701c16a782c542de03dec672db89e8d4`. Zaliczyło 446 testów Node, kontrola typów, GitHub Actions oraz SonarCloud. Późniejsze commity dokumentacyjne sprawdzaj osobno. [GitHub Actions](https://github.com/staguak/aktualizator-nl-ue/actions/runs/44912942541) · [SonarCloud](https://sonarcloud.io/dashboard?id=staguak_aktualizator-nl-ue&pullRequest=24)
- PPP Ostatnio odczytany produkcyjny `main` to `c1d52642047ca18de58f4bde3e855931e705bb40`, a `dane` to `824aca70944604b5499e47c0c27dcf0dd7bfe689`. Zmiany aplikacji były publikowane do roboczego PR.
- PPP Pełne BASE i UPDATE przeszły niezależne audyty w osobnych próbach. Połączone pełne wyniki pozwoliły zapisać i odczytać jedną lokalną migawkę przy pustym `dane`. Osobno pełna migracja z istniejącego `dane` przeszła lokalny odczyt. Pełny przebieg obu faz na jednym SHA pozostaje otwarty.
- PPP Preflight potrafi potwierdzić bezpośrednie grafiki z audytowanego indeksu odpowiedzią 304 przy zweryfikowanych bajtach w cache. Dla katalogu BWB SRU 2.0 potrafi porównać SHA-256 krótkiej odpowiedzi 200 przy braku walidatorów. Grafiki zastępcze, pochodne i niedostępne wracają do pełnego audytu.

## Następne zadanie

Dokończ próbę **pełnego BASE→UPDATE w izolacji na jednym SHA**. Wcześniejszy przebieg `202611191547` na `b49f12d` zakończył się na limicie czasu w BASE. Zapisano 23/23 aktów NL i 58/63 pozycji UE, ale po przywróceniu środowiska dawnych checkpointów w `/tmp` nie znaleziono. Jeżeli nie ma kompletnych, zgodnych checkpointów danej rewizji i konfiguracji, zacznij od nowego lokalnego przebiegu. Nie przyjmuj historycznej migawki za PASS na innym SHA.

1. Zapewnij czysty, izolowany checkout i zależności według sekcji lokalnego budowania w [README](../README.md). W `aktualizator-ph/` uruchom publiczne wejście `node --import tsx src/github-build.ts` w trybie `LAW_PUBLIC_INITIALIZE=true` po ustawieniu wymaganego interpretera i zależności XML. Proces ma działać bez tokenów GitHub i poświadczeń Drive. Zapisz SHA, zakres, log i ścieżkę do dowodów. Dla powtórki historycznego scenariusza zapisano BASE na 1.01.2025 i UPDATE na 19.11.2026. Przy bieżącej próbie odnotuj rzeczywiście użyte daty.
2. Wymagaj niezależnego PASS dla obu modułów w obu fazach. Zanotuj tożsamość wersji, kompletność historii i SHA-256. Połącz i odczytaj pełną migawkę w lokalnym Git z dokładną dzierżawą refa. Sprawdź osobne progi bajtów dla NL i UE przy aktualizacji istniejącej bazy. Awaria którejkolwiek fazy nie może przesunąć refa.
3. Jeżeli dostępny blok pracy jest za krótki na pełny audyt, wykonaj zadanie dające się domknąć lokalnie. Najbliższe jest zachowanie i sprawdzanie dowodu wyboru grafiki zastępczej, w tym pełnego urzędowego żądania dokumentu FR i wyniku wcześniejszej próby EN dla `01992L0058-20190726`. Po integracji przetestuj ponowną dostępność EN, zmianę grafiki, brak walidatora i obce przekierowanie. Brak dowodu oznacza pełny audyt. Po zakończeniu zapisz punkt wznowienia zgodnie z limitem i dyspozycją użytkownika.

## Po tych zadaniach

- Dokończyć szybkie sprawdzanie grafik pochodnych, granicy dnia i pełny `NO_CHANGE` na świeżych urzędowych odpowiedziach. Przy dowiedzionym braku zmian sprawdzić identyczny HEAD i wyłączność `wait.md`.
- Zweryfikować pełną matrycę terytorialną i przypadki dat z [§3–4 specyfikacji](SPECYFIKACJA_AKTUALIZATORA_NL_UE.md). `APPLICABILITY_UNKNOWN` zachowuje dokument i pozostaje odrębną miarą jakości.
- Domknąć porównanie 75 historycznych wyjątków językowych, zimny start, kompatybilność odbiorców i kontrolowany odbiór CI. Do migracji produkcyjnej mogą być potrzebne odrębne decyzje ze specyfikacji.

## Punkty w kodzie

| Obszar | Pliki w `aktualizator-ph/` |
|---|---|
| Fazy, wejście i publikacja | `src/github-build.ts`, `src/public-build-phases.ts`, `scripts/public_github.py`, `scripts/public_corpus.py` |
| Warunkowy dowód źródeł i grafik | `src/public-preflight.ts`, `src/source-cache.ts`, `src/sru.ts`, `src/official-image-source.ts`, `src/eu-image-resolver.ts` |
| Dobór i audyt prawa | `src/eu-provider.ts`, `src/eu-applicability.ts`, `src/eu-dates.ts`, `scripts/verify_official_output.py` |

Gdy zamkniesz punkt, popraw ten plik i dziennik. Szczegółowe kryteria C01–C11 i U01–U12 są w [specyfikacji](SPECYFIKACJA_AKTUALIZATORA_NL_UE.md).
