# Ochrona kodu na main

Publiczny dostęp sam w sobie nie daje prawa zmiany repozytorium. Osoby bez uprawnień
zapisu mogą czytać, tworzyć kopie oraz zgłaszać poprawki. Właściciel kontroluje scalenie.

Dodatkową ochronę przed przypadkową zmianą właściciela lub integracji ustawia właściciel:

1. Otwórz Settings → Branches → Add branch protection rule, wzorzec `main`.
2. Włącz **Require a pull request before merging**. Jeśli pracujesz sam, pozostaw
   **Require approvals** wyłączone, aby nie wymagać drugiej osoby.
3. Włącz **Require status checks to pass before merging** i wybierz test **`verify`**.
4. Pozostaw **Allow force pushes** oraz **Allow deletions** wyłączone.
5. Możesz włączyć **Do not allow bypassing the above settings**, aby reguła dotyczyła
   również administratora. Zmiany wtedy przechodzą przez PR i testy.

Nie ustawiaj tej samej blokady force push dla `dane`: ta gałąź celowo przechowuje jeden
bieżący snapshot bez poprzednich commitów. Publikator używa dokładnego lease poprzedniej
rewizji i nigdy nie zapisuje do `main`. Jego krótkotrwały token ma zakres `contents: write`
na poziomie repo; ograniczenie gałęzi jest realizowane przez sprawdzony kod publikatora,
a ochrona `main` stanowi dodatkową blokadę po stronie GitHub.

Repozytorium nie uruchamia kodu PR z uprawnieniami publikatora. Publiczne zgłoszenie
uruchamia wyłącznie kod z `main`; jego treść nie jest wykonywana ani używana jako konfiguracja.

Do zmiany ochrony potrzebne są uprawnienia administracyjne integracji. Jeśli API zwraca
403, ustawienie musi wykonać właściciel w interfejsie GitHub. Sam commit z tą instrukcją
nie włącza ochrony gałęzi.
