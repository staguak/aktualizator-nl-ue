# AGENTS.md — stałe zasady współpracy w repozytorium

Repozytorium: `staguak/aktualizator-nl-ue`.

## Najważniejsza reguła: jeden roboczy PR i jeden widoczny commit

1. **Kontynuuj ten sam PR.** Przed każdą pracą sprawdź otwarte pull requesty. W kolejnych zadaniach, etapach, poprawkach i testach korzystaj z tego samego, wskazanego roboczego PR oraz tej samej gałęzi. Nie otwieraj nowego PR tylko dlatego, że rozpoczyna się kolejny etap.
2. **Utrzymuj jeden commit w gałęzi roboczego PR.** Nowe zmiany, poprawki i testy włączaj do istniejącego commita przez `git commit --amend` albo squash. Następnie użyj `git push --force-with-lease` (lub równoważnej aktualizacji ref z weryfikacją oczekiwanego SHA). Nigdy nie używaj bezwarunkowego `--force`, nie nadpisuj cudzej pracy i nie przepisuj historii `main`.
3. **Nie scalaj i nie zamykaj roboczego PR bez wyraźnego polecenia użytkownika.** Zakończenie zadania lub etapu nie stanowi zgody na scalenie czy zamknięcie. Nie zakładaj automatycznie kolejnego PR.
4. **Najpierw sprawdź ograniczenia i stan.** Przed zmianą sprawdź aktywny PR, gałąź, aktualny SHA, historię, konflikty i statusy testów. Po zmianach zweryfikuj zachowanie i poinformuj, co jest faktycznie ukończone.
5. **Nie ukrywaj ograniczeń narzędzia.** Jeśli dostępne narzędzie GitHub pozwala jedynie dopisywać kolejne commity (np. Contents API), a nie pozwala bezpiecznie zastąpić dotychczasowego, nie obchodź reguły po cichu. Poinformuj użytkownika, że utrzymanie jednego commita wymaga obsługi amend/squash i bezpiecznej aktualizacji gałęzi.
6. **Istniejących innych PR nie zamykaj automatycznie.** Jedna stała gałąź/PR dotyczy bieżącego toku pracy. W razie niejasności, który z istniejących PR jest roboczy, ustal to przed wprowadzaniem niezwiązanych zmian.

### Ograniczenia Git i GitHub

- `git commit --amend` nadaje nowy SHA — **jeden commit** oznacza jeden widoczny commit na gałęzi roboczej względem bazy, nie niezmienny identyfikator i nie jeden commit w całym repozytorium.
- PR po scaleniu lub zamknięciu **nie może być dalej wykorzystywany jako ten sam otwarty PR**. Nie scalaj go w trakcie ciągłej pracy, jeżeli użytkownik oczekuje dalszych iteracji. Po świadomie zleconym scaleniu dalsza praca wymaga nowej decyzji.
- Testy, kontrola bezpieczeństwa i ochrona gałęzi obowiązują nadal. Nie obchodź wymogu PR ani testów tylko po to, by zachować jednego commita.

## English instructions for coding agents

Keep **one user-designated, long-lived working pull request** and **one visible commit on that PR branch** for successive tasks. Amend/squash updates into the existing commit and move the branch with `--force-with-lease` or an expected-SHA lease; never blind-force or rewrite `main`. Do not open, merge, or close PRs automatically. Check existing PRs, branch head, and CI first; ask which PR is designated when ambiguous. If tool limitations prevent preserving one commit, disclose that before creating extra commits. A merged/closed PR cannot be reused.
