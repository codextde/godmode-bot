import type { Lang } from '@/i18n';

export type How = 'browser' | 'app' | 'desktop' | 'vm' | 'chat';

export const HOW: Record<How, { icon: string; label: Record<Lang, string> }> = {
  browser: { icon: 'globe', label: { en: 'Browser, signed in', de: 'Im Browser, angemeldet' } },
  app: { icon: 'app-window', label: { en: 'App in the background', de: 'App im Hintergrund' } },
  desktop: { icon: 'monitor', label: { en: 'Whole desktop', de: 'Ganzer Desktop' } },
  vm: { icon: 'monitor-smartphone', label: { en: 'Its own Mac', de: 'Eigener Mac' } },
  chat: { icon: 'message-circle', label: { en: 'From Slack or Telegram', de: 'Aus Slack oder Telegram' } },
};

type Text = [problem: string, message: string, when: string];
export interface Case {
  how: How;
  en: Text;
  de: Text;
}
export interface Group {
  key: string;
  icon: string;
  name: Record<Lang, string>;
  items: Case[];
}

const c = (how: How, en: Text, de: Text): Case => ({ how, en, de });

export const GROUPS: Group[] = [
  {
    key: 'admin',
    icon: 'inbox',
    name: { en: 'Inbox & admin', de: 'Postfach & Verwaltung' },
    items: [
      c(
        'browser',
        ['I have 400 unread emails and no idea what matters.', 'Go through my inbox from the last two weeks. Archive newsletters, draft replies to anything a customer or colleague is waiting on, and give me a list of the 10 that need me.', 'Once'],
        ['Ich habe 400 ungelesene E-Mails und keine Ahnung, was wichtig ist.', 'Geh mein Postfach der letzten zwei Wochen durch. Archivier die Newsletter, schreib Antwortentwürfe für alles, worauf ein Kunde oder Kollege wartet, und gib mir eine Liste mit den 10 Mails, die mich brauchen.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Scheduling a meeting takes six emails.', 'Find a 45-minute slot next week that works for me, Anna and Tom, send the invite and put the agenda from this thread in it.', 'Once'],
        ['Einen Termin abzustimmen kostet sechs E-Mails.', 'Such nächste Woche einen 45-Minuten-Termin, der für mich, Anna und Tom passt, schick die Einladung raus und setz die Agenda aus diesem Thread rein.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Every government portal wants a different login and a 2FA code.', 'Log into the tax office portal, download every notice from this year and save them in Documents › Tax › 2026 with readable names.', 'Quarterly'],
        ['Jedes Behördenportal will einen anderen Login und einen 2FA-Code.', 'Melde dich im Portal vom Finanzamt an, lade alle Bescheide aus diesem Jahr herunter und speicher sie mit lesbaren Namen unter Dokumente › Steuer › 2026.', 'Vierteljährlich'],
      ),
      c(
        'app',
        ['My Downloads folder is a landfill.', 'Sort my Downloads folder: invoices into Finance, screenshots into Pictures › Screenshots, installers into the trash. Show me the plan before you move anything.', 'Monthly'],
        ['Mein Downloads-Ordner ist eine Müllhalde.', 'Räum meinen Downloads-Ordner auf: Rechnungen nach Finanzen, Screenshots nach Bilder › Screenshots, Installer in den Papierkorb. Zeig mir den Plan, bevor du etwas verschiebst.', 'Monatlich'],
      ),
      c(
        'browser',
        ['Forms, forms, forms.', 'Fill the supplier onboarding form at this link with our company data from the shared drive. Stop before submitting and show me a screenshot.', 'Once'],
        ['Formulare, Formulare, Formulare.', 'Füll das Onboarding-Formular für Lieferanten unter diesem Link mit unseren Firmendaten aus dem gemeinsamen Laufwerk aus. Schick es nicht ab, sondern zeig mir vorher einen Screenshot.', 'Einmalig'],
      ),
      c(
        'chat',
        ['I forget to renew things until they break.', 'Every month, check when our domains, insurance policies, leases and the car’s inspection are due and tell me on Telegram about anything in the next 30 days.', 'Monthly'],
        ['Ich vergesse Verlängerungen, bis etwas nicht mehr läuft.', 'Prüf jeden Monat, wann unsere Domains, Versicherungen, Mietverträge und der TÜV fürs Auto fällig sind, und sag mir auf Telegram Bescheid, wenn in den nächsten 30 Tagen etwas ansteht.', 'Monatlich'],
      ),
    ],
  },
  {
    key: 'finance',
    icon: 'landmark',
    name: { en: 'Finance', de: 'Finanzen' },
    items: [
      c(
        'browser',
        ['Collecting invoices from portals eats my Monday.', 'Log into each supplier portal in my vault, download last month’s invoices, file them in Drive › Invoices › {month} and post the totals to #finance.', 'Monthly'],
        ['Rechnungen aus Portalen zusammensuchen frisst meinen Montag.', 'Melde dich bei jedem Lieferantenportal aus meinem Tresor an, lade die Rechnungen vom letzten Monat herunter, leg sie unter Drive › Rechnungen › {Monat} ab und poste die Summen in #finance.', 'Monatlich'],
      ),
      c(
        'browser',
        ['Stripe payouts never match the bank statement.', 'Match last week’s Stripe payouts against our online banking. List every payout that doesn’t add up, with links to both sides.', 'Weekly'],
        ['Die Stripe-Auszahlungen passen nie zum Kontoauszug.', 'Gleich die Stripe-Auszahlungen der letzten Woche mit unserem Onlinebanking ab. Liste jede Auszahlung auf, die nicht aufgeht, mit Links zu beiden Seiten.', 'Wöchentlich'],
      ),
      c(
        'browser',
        ['Our accountant keeps asking for missing receipts.', 'Find every card transaction from September without a receipt in our accounting tool, search my email for each one and upload what you find.', 'Monthly'],
        ['Unser Steuerberater fragt ständig nach fehlenden Belegen.', 'Such in unserem Buchhaltungstool alle Kartenzahlungen aus dem September ohne Beleg, such zu jeder in meinen E-Mails und lade hoch, was du findest.', 'Monatlich'],
      ),
      c(
        'browser',
        ['Customers pay late and I hate chasing them.', 'Find invoices more than 14 days overdue and draft a friendly reminder for each customer in Gmail drafts. Don’t send.', 'Weekly'],
        ['Kunden zahlen zu spät und ich laufe ungern hinterher.', 'Such alle Rechnungen, die mehr als 14 Tage überfällig sind, und schreib für jeden Kunden eine freundliche Zahlungserinnerung als Entwurf in Gmail. Nicht senden.', 'Wöchentlich'],
      ),
      c(
        'browser',
        ['We pay for software nobody uses.', 'List every subscription charged to the company card last quarter with its price and last login. Flag anything unused for 60 days.', 'Quarterly'],
        ['Wir zahlen für Software, die keiner nutzt.', 'Liste jedes Abo auf, das letztes Quartal über die Firmenkarte abgebucht wurde, mit Preis und letztem Login. Markier alles, was seit 60 Tagen nicht genutzt wurde.', 'Vierteljährlich'],
      ),
      c(
        'app',
        ['The budget spreadsheet is always out of date.', 'Open the budget workbook in Excel, update the actuals sheet from this month’s bank export and highlight every line more than 10% over plan.', 'Monthly'],
        ['Die Budget-Tabelle ist nie aktuell.', 'Öffne die Budget-Mappe in Excel, aktualisier das Ist-Blatt mit dem Bankexport von diesem Monat und markier jede Zeile, die mehr als 10 % über Plan liegt.', 'Monatlich'],
      ),
    ],
  },
  {
    key: 'sales',
    icon: 'handshake',
    name: { en: 'Sales', de: 'Vertrieb' },
    items: [
      c(
        'browser',
        ['My CRM is always a week behind.', 'After each call in my calendar, update the deal in HubSpot with notes, next step and close date, and draft the follow-up in Gmail.', 'After every call'],
        ['Mein CRM hängt immer eine Woche hinterher.', 'Aktualisier nach jedem Call in meinem Kalender den Deal in HubSpot mit Notizen, nächstem Schritt und Abschlussdatum und schreib das Follow-up als Entwurf in Gmail.', 'Nach jedem Call'],
      ),
      c(
        'browser',
        ['Researching leads takes longer than talking to them.', 'For each company in this sheet, find website, headcount, recent news and the right contact on LinkedIn. Fill in the columns.', 'Once'],
        ['Leads zu recherchieren dauert länger, als mit ihnen zu reden.', 'Such für jede Firma in dieser Tabelle Website, Mitarbeiterzahl, aktuelle News und den richtigen Ansprechpartner auf LinkedIn. Füll die Spalten aus.', 'Einmalig'],
      ),
      c(
        'chat',
        ['Deals go quiet and I notice too late.', 'Every evening, list prospects who haven’t replied in 3 days and send me a one-line nudge suggestion for each on Telegram.', 'Daily'],
        ['Deals schlafen ein und ich merke es zu spät.', 'Liste jeden Abend die Interessenten auf, die seit 3 Tagen nicht geantwortet haben, und schick mir auf Telegram für jeden einen Vorschlag für eine kurze Nachfass-Nachricht.', 'Täglich'],
      ),
      c(
        'browser',
        ['Proposals take a whole afternoon.', 'Build a proposal for {company} in our Google Docs template from my last call notes and the pricing sheet. Leave it as a draft.', 'Once'],
        ['Angebote kosten einen ganzen Nachmittag.', 'Erstell ein Angebot für {Firma} in unserer Google-Docs-Vorlage aus meinen Notizen vom letzten Call und der Preisliste. Lass es als Entwurf.', 'Einmalig'],
      ),
      c(
        'browser',
        ['I want to know who visited our pricing page.', 'Every morning, check which target accounts visited our pricing page yesterday in our analytics and add them to the “warm” list in the CRM.', 'Daily'],
        ['Ich will wissen, wer unsere Preisseite besucht hat.', 'Schau jeden Morgen in unserer Analytics nach, welche Zielkunden gestern unsere Preisseite besucht haben, und setz sie im CRM auf die Liste „warm“.', 'Täglich'],
      ),
      c(
        'browser',
        ['Trade-show leads rot in a spreadsheet.', 'Import the 140 leads from this booth scan export into our CRM, dedupe against existing contacts and draft a personal follow-up for the top 20.', 'Once'],
        ['Messe-Leads verstauben in einer Tabelle.', 'Importier die 140 Leads aus diesem Export vom Messestand in unser CRM, gleich sie mit bestehenden Kontakten auf Dubletten ab und schreib für die besten 20 ein persönliches Follow-up als Entwurf.', 'Einmalig'],
      ),
    ],
  },
  {
    key: 'marketing',
    icon: 'megaphone',
    name: { en: 'Marketing & ads', de: 'Marketing & Werbung' },
    items: [
      c(
        'browser',
        ['Ad reporting is four dashboards and a copy-paste job.', 'Pull spend, clicks and sales from Meta, Google and TikTok Ads into our reporting sheet and flag every campaign that costs more than $80 per sale.', 'Fridays'],
        ['Werbe-Reporting heißt vier Dashboards und Copy-and-paste.', 'Hol Ausgaben, Klicks und Verkäufe aus Meta, Google und TikTok Ads in unsere Report-Tabelle und markier jede Kampagne, die mehr als $80 pro Verkauf kostet.', 'Freitags'],
      ),
      c(
        'browser',
        ['Some ads spend money and never sell.', 'Every morning, find the ads that spent more than $50 without a single sale. Send me the list and pause the ones I say yes to.', 'Daily'],
        ['Manche Anzeigen kosten Geld und verkaufen nie.', 'Such jeden Morgen die Anzeigen, die mehr als $50 ausgegeben haben, ohne einen einzigen Verkauf. Schick mir die Liste und pausier die, zu denen ich Ja sage.', 'Täglich'],
      ),
      c(
        'browser',
        ['Our best ad is getting tired.', 'Look at our three best-selling Meta ads from last month and write five new versions of each: new hook, same offer. Put them in the ads doc for my review.', 'Weekly'],
        ['Unsere beste Anzeige nutzt sich ab.', 'Schau dir unsere drei Meta-Anzeigen mit den meisten Verkäufen vom letzten Monat an und schreib von jeder fünf neue Versionen: neuer Aufhänger, gleiches Angebot. Leg sie zum Prüfen in unser Anzeigen-Dokument.', 'Wöchentlich'],
      ),
      c(
        'browser',
        ['Competitors change prices and I hear about it from customers.', 'Watch the pricing pages of these three competitors. When anything changes, send me a screenshot and a two-line summary.', 'When it changes'],
        ['Konkurrenten ändern ihre Preise und ich erfahre es von Kunden.', 'Behalte die Preisseiten dieser drei Konkurrenten im Blick. Wenn sich etwas ändert, schick mir einen Screenshot und eine Zusammenfassung in zwei Zeilen.', 'Bei Änderungen'],
      ),
      c(
        'browser',
        ['Our search traffic dropped and nobody knows why.', 'Check Search Console for pages that lost more than 20% clicks week over week and suggest one concrete fix for each.', 'Weekly'],
        ['Unser Suchtraffic ist eingebrochen und keiner weiß, warum.', 'Such in der Search Console nach Seiten, die im Vergleich zur Vorwoche mehr als 20 % Klicks verloren haben, und schlag für jede eine konkrete Lösung vor.', 'Wöchentlich'],
      ),
      c(
        'browser',
        ['Reviews go unanswered for weeks.', 'Reply to new Google reviews in our voice. Send me anything under 3 stars before you answer it.', 'Daily'],
        ['Bewertungen bleiben wochenlang unbeantwortet.', 'Antworte auf neue Google-Bewertungen in unserem Ton. Schick mir alles unter 3 Sternen, bevor du darauf antwortest.', 'Täglich'],
      ),
    ],
  },
  {
    key: 'ecommerce',
    icon: 'shopping-bag',
    name: { en: 'E-commerce', de: 'Onlineshop' },
    items: [
      c(
        'browser',
        ['Where is my order? Fifty times a day.', 'Answer new “where is my order” tickets with the live tracking link from Shopify and our shipping policy. Escalate anything older than 10 days to me.', 'When a ticket arrives'],
        ['„Wo ist meine Bestellung?“ Fünfzigmal am Tag.', 'Beantworte neue „Wo ist meine Bestellung“-Tickets mit dem aktuellen Tracking-Link aus Shopify und unseren Versandbedingungen. Alles, was älter als 10 Tage ist, gibst du an mich weiter.', 'Bei neuem Ticket'],
      ),
      c(
        'browser',
        ['We run out of best-sellers.', 'Every morning, check Shopify stock against the last 30 days of sales and draft purchase orders for anything with less than two weeks left.', 'Daily'],
        ['Unsere Bestseller sind ständig ausverkauft.', 'Gleich jeden Morgen den Bestand in Shopify mit den Verkäufen der letzten 30 Tage ab und schreib Bestellentwürfe für alles, was in weniger als zwei Wochen ausgeht.', 'Täglich'],
      ),
      c(
        'browser',
        ['Product pages are thin and inconsistent.', 'Rewrite the descriptions of these 25 products in our tone, add size and material details from the supplier PDFs and save them as drafts.', 'Once'],
        ['Produktseiten sind dünn und uneinheitlich.', 'Schreib die Beschreibungen dieser 25 Produkte in unserem Ton neu, ergänz Größen- und Materialangaben aus den PDFs vom Lieferanten und speicher sie als Entwürfe.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Marketplace listings drift out of sync.', 'Compare prices and stock between our Shopify store and our Amazon listings and fix every mismatch in Seller Central. Show me the list first.', 'Daily'],
        ['Die Angebote auf Marktplätzen laufen auseinander.', 'Vergleich Preise und Bestand zwischen unserem Shopify-Shop und unseren Amazon-Angeboten und korrigier jede Abweichung in Seller Central. Zeig mir vorher die Liste.', 'Täglich'],
      ),
      c(
        'browser',
        ['Returns are a manual mess.', 'Process today’s return requests: check the order, create the return label in our shipping tool, email it to the customer and log it in the returns sheet.', 'Daily'],
        ['Retouren sind mühsame Handarbeit.', 'Bearbeite die Retourenanfragen von heute: Bestellung prüfen, Retourenlabel in unserem Versandtool erstellen, per E-Mail an den Kunden schicken und in der Retouren-Tabelle eintragen.', 'Täglich'],
      ),
      c(
        'browser',
        ['Supplier orders still go by email.', 'For every new order with dropship items, place the order in the supplier’s portal and paste the tracking number back into Shopify when it arrives.', 'When an order comes in'],
        ['Bestellungen beim Lieferanten laufen noch per E-Mail.', 'Gib für jede neue Bestellung mit Dropshipping-Artikeln die Bestellung im Portal des Lieferanten auf und trag die Sendungsnummer in Shopify ein, sobald sie da ist.', 'Bei neuer Bestellung'],
      ),
    ],
  },
  {
    key: 'support',
    icon: 'life-buoy',
    name: { en: 'Support', de: 'Kundenservice' },
    items: [
      c(
        'browser',
        ['The same five questions fill the support queue.', 'Answer new Zendesk tickets that our help center already covers, link the article, and leave the rest assigned to me.', 'When a ticket arrives'],
        ['Dieselben fünf Fragen füllen die Support-Warteschlange.', 'Beantworte neue Zendesk-Tickets, die unser Hilfecenter schon abdeckt, verlinke den passenden Artikel und lass den Rest mir zugewiesen.', 'Bei neuem Ticket'],
      ),
      c(
        'browser',
        ['Customers write in three languages.', 'Answer new customer emails in French, Spanish and Italian in our usual tone using our help center, and keep an English copy of each answer for me.', 'When an email arrives'],
        ['Kunden schreiben in drei Sprachen.', 'Beantworte neue Kunden-E-Mails auf Französisch, Spanisch und Italienisch in unserem üblichen Ton anhand unseres Hilfecenters und leg mir von jeder Antwort eine deutsche Kopie ab.', 'Bei neuer E-Mail'],
      ),
      c(
        'browser',
        ['Refunds need three tools.', 'For refund requests under $50, check the order in Shopify, refund it in Stripe and reply to the customer. Ask me for anything bigger.', 'When a ticket arrives'],
        ['Erstattungen brauchen drei Tools.', 'Prüf bei Erstattungsanfragen unter $50 die Bestellung in Shopify, erstatte sie in Stripe und antworte dem Kunden. Bei allem, was größer ist, frag mich.', 'Bei neuem Ticket'],
      ),
      c(
        'browser',
        ['Our help center is outdated.', 'Read last month’s tickets, find the 10 most common questions without a good article, and draft those articles in our help center as unpublished.', 'Monthly'],
        ['Unser Hilfecenter ist veraltet.', 'Lies die Tickets vom letzten Monat, finde die 10 häufigsten Fragen ohne guten Artikel und schreib diese Artikel als unveröffentlichte Entwürfe in unser Hilfecenter.', 'Monatlich'],
      ),
      c(
        'chat',
        ['Nobody reads the weekly support numbers.', 'Every Monday, post five lines to #support: volume, first response time, top three topics and one thing we should fix.', 'Weekly'],
        ['Keiner liest die wöchentlichen Support-Zahlen.', 'Poste jeden Montag fünf Zeilen in #support: Ticketzahl, Zeit bis zur ersten Antwort, die drei häufigsten Themen und eine Sache, die wir beheben sollten.', 'Wöchentlich'],
      ),
      c(
        'chat',
        ['Phone notes never reach the ticket.', 'Take the call notes I paste in Slack, find the customer’s ticket and add them as an internal note with the next step.', 'When I paste notes'],
        ['Telefonnotizen landen nie im Ticket.', 'Nimm die Gesprächsnotizen, die ich in Slack einfüge, such das Ticket des Kunden und füg sie dort als interne Notiz mit dem nächsten Schritt hinzu.', 'Wenn ich Notizen einfüge'],
      ),
    ],
  },
  {
    key: 'social',
    icon: 'share-2',
    name: { en: 'Social media & content', de: 'Social Media & Content' },
    items: [
      c(
        'browser',
        ['Posting every day is a second job.', 'Plan next week’s Instagram and LinkedIn posts from our product list, write the captions in our voice and schedule them. Show me the plan before anything goes live.', 'Weekly'],
        ['Jeden Tag zu posten ist ein zweiter Job.', 'Plane die Instagram- und LinkedIn-Posts für nächste Woche anhand unserer Produktliste, schreib die Texte in unserem Ton und plane sie ein. Zeig mir den Plan, bevor etwas live geht.', 'Wöchentlich'],
      ),
      c(
        'browser',
        ['One blog post should be ten posts.', 'Turn today’s blog post into a LinkedIn post, an Instagram caption and a newsletter blurb in our voice. Save them as drafts for my review.', 'When a post goes live'],
        ['Aus einem Blogartikel sollten zehn Posts werden.', 'Mach aus dem heutigen Blogartikel einen LinkedIn-Post, eine Instagram-Caption und einen kurzen Newsletter-Text in unserem Ton. Speicher alles als Entwurf, damit ich es prüfen kann.', 'Wenn ein Artikel live geht'],
      ),
      c(
        'browser',
        ['Comments and DMs pile up.', 'Answer new comments and DMs on our Instagram and Facebook pages with the answers from our FAQ doc. Leave anything about refunds or complaints for me.', 'Daily'],
        ['Kommentare und DMs stapeln sich.', 'Beantworte neue Kommentare und DMs auf unseren Instagram- und Facebook-Seiten mit den Antworten aus unserem FAQ-Dokument. Alles zu Erstattungen oder Beschwerden lässt du für mich liegen.', 'Täglich'],
      ),
      c(
        'browser',
        ['Finding creators takes forever.', 'Find 20 Instagram and TikTok creators in home and living with 10k to 100k followers, add their engagement and contact email to our creator sheet and draft a short personal message for each.', 'Once'],
        ['Creator zu finden dauert ewig.', 'Such 20 Instagram- und TikTok-Creator aus dem Bereich Wohnen und Einrichten mit 10.000 bis 100.000 Followern, trag Engagement und Kontakt-E-Mail in unsere Creator-Tabelle ein und schreib für jeden eine kurze persönliche Nachricht als Entwurf.', 'Einmalig'],
      ),
      c(
        'browser',
        ['The newsletter always goes out late.', 'Write this month’s newsletter in Mailchimp from our three latest posts and new products, send me a test email and schedule it for Thursday 9:00 once I say OK.', 'Monthly'],
        ['Der Newsletter geht immer zu spät raus.', 'Schreib den Newsletter für diesen Monat in Mailchimp aus unseren drei neuesten Posts und den neuen Produkten, schick mir eine Test-Mail und plane ihn für Donnerstag, 9:00 Uhr ein, sobald ich OK sage.', 'Monatlich'],
      ),
      c(
        'browser',
        ['Every channel wants a different image size.', 'Open our banner in Canva, make the five size variants on this list with the new headline and save them as PNG in the shared folder.', 'Once'],
        ['Jeder Kanal will eine andere Bildgröße.', 'Öffne unser Banner in Canva, erstell die fünf Größen von dieser Liste mit der neuen Überschrift und speicher sie als PNG im gemeinsamen Ordner.', 'Einmalig'],
      ),
    ],
  },
  {
    key: 'research',
    icon: 'search',
    name: { en: 'Research', de: 'Recherche' },
    items: [
      c(
        'browser',
        ['I need a market overview by Friday.', 'Find every company selling AI bookkeeping to small businesses in Germany. For each: website, pricing, funding and one sentence on the angle. Put it in a sheet.', 'Once'],
        ['Ich brauche bis Freitag einen Marktüberblick.', 'Such alle Firmen, die KI-Buchhaltung für kleine Unternehmen in Deutschland anbieten. Für jede: Website, Preise, Finanzierung und ein Satz zum Ansatz. Pack alles in eine Tabelle.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Which tool should we buy?', 'Compare these four project-management tools for a 12-person agency: price, Gantt, client access, time tracking. Sign up for trials if you need to and give me a recommendation.', 'Once'],
        ['Welches Tool sollen wir kaufen?', 'Vergleich diese vier Projektmanagement-Tools für eine Agentur mit 12 Leuten: Preis, Gantt, Kundenzugang, Zeiterfassung. Meld dich für Testversionen an, wenn nötig, und gib mir eine Empfehlung.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Tenders slip past us.', 'Every morning, search the public tender portals for marketing and website projects in our region and send me new ones with deadline and budget.', 'Daily'],
        ['Ausschreibungen rutschen uns durch.', 'Durchsuch jeden Morgen die öffentlichen Vergabeportale nach Marketing- und Website-Projekten in unserer Region und schick mir neue mit Frist und Budget.', 'Täglich'],
      ),
      c(
        'app',
        ['Long PDFs I’ll never read.', 'Read the 80-page contract in my Downloads folder and list every clause about termination, liability and auto-renewal with page numbers.', 'Once'],
        ['Lange PDFs, die ich nie lesen werde.', 'Lies den 80-seitigen Vertrag in meinem Downloads-Ordner und liste jede Klausel zu Kündigung, Haftung und automatischer Verlängerung mit Seitenzahl auf.', 'Einmalig'],
      ),
      c(
        'browser',
        ['I want a price alert, not a tab I refresh.', 'Watch the price of this flight and this monitor. Tell me when either drops by more than 10%.', 'When it changes'],
        ['Ich will einen Preisalarm, keinen Tab, den ich ständig neu lade.', 'Behalte den Preis von diesem Flug und diesem Monitor im Blick. Sag mir Bescheid, wenn einer von beiden um mehr als 10 % fällt.', 'Bei Änderungen'],
      ),
      c(
        'browser',
        ['Hiring takes forever to start.', 'Find 30 experienced bookkeepers in Munich who are open to work, with profile links and why each fits, and put them in our hiring sheet.', 'Once'],
        ['Bis die Suche nach neuen Leuten anläuft, dauert es ewig.', 'Such 30 erfahrene Buchhalter in München, die offen für einen neuen Job sind, mit Profil-Links und warum jeder passt, und trag sie in unsere Recruiting-Tabelle ein.', 'Einmalig'],
      ),
    ],
  },
  {
    key: 'it',
    icon: 'building-2',
    name: { en: 'Office & IT', de: 'Büro & IT' },
    items: [
      c(
        'browser',
        ['Onboarding a new hire touches ten tools.', 'Create accounts for our new hire Lisa in Google Workspace, Slack, Notion and our HR tool, add her to the right groups and calendars, and send me the checklist when done.', 'When someone joins'],
        ['Eine neue Kollegin einzurichten heißt zehn Tools.', 'Leg für unsere neue Kollegin Lisa Konten in Google Workspace, Slack, Notion und unserem HR-Tool an, füg sie den richtigen Gruppen und Kalendern hinzu und schick mir die Checkliste, wenn du fertig bist.', 'Wenn jemand anfängt'],
      ),
      c(
        'browser',
        ['Offboarding is where security leaks.', 'Remove Max from every tool on our offboarding list, transfer his files to me and confirm each step in #ops.', 'When someone leaves'],
        ['Beim Offboarding entstehen Sicherheitslücken.', 'Entferne Max aus jedem Tool auf unserer Offboarding-Liste, übertrag seine Dateien an mich und bestätige jeden Schritt in #ops.', 'Wenn jemand geht'],
      ),
      c(
        'chat',
        ['The office runs out of coffee. Again.', 'When someone writes “we’re out of …” in #office, reorder it from our Amazon Business account and confirm in the thread.', 'When someone asks'],
        ['Im Büro ist der Kaffee alle. Schon wieder.', 'Wenn jemand in #office „Wir haben kein … mehr“ schreibt, bestell es über unser Amazon-Business-Konto nach und bestätige es im Thread.', 'Wenn jemand fragt'],
      ),
      c(
        'app',
        ['Old office software nobody wants to touch.', 'Open our old order program, export yesterday’s orders as a spreadsheet and upload it to the shared drive.', 'Daily'],
        ['Alte Bürosoftware, die keiner anfassen will.', 'Öffne unser altes Bestellprogramm, exportier die Bestellungen von gestern als Tabelle und lade sie ins gemeinsame Laufwerk hoch.', 'Täglich'],
      ),
      c(
        'browser',
        ['The printer runs out of toner on deadline day.', 'Every Friday, check the toner levels on the office printer’s status page and order new cartridges from our usual supplier for anything under 20%.', 'Weekly'],
        ['Dem Drucker geht genau am Abgabetag der Toner aus.', 'Prüf jeden Freitag die Tonerstände auf der Statusseite des Bürodruckers und bestell bei unserem üblichen Lieferanten neue Kartuschen für alles unter 20 %.', 'Wöchentlich'],
      ),
      c(
        'vm',
        ['New software shouldn’t mess up a work laptop.', 'On your own Mac, install the trial versions of these three PDF editors, try merging and signing a test file in each and tell me which one is easiest.', 'Once'],
        ['Neue Software soll keinen Arbeitslaptop durcheinanderbringen.', 'Installier auf deinem eigenen Mac die Testversionen dieser drei PDF-Editoren, probier in jedem, eine Testdatei zusammenzuführen und zu unterschreiben, und sag mir, welcher am einfachsten ist.', 'Einmalig'],
      ),
    ],
  },
  {
    key: 'personal',
    icon: 'heart',
    name: { en: 'Personal', de: 'Privat' },
    items: [
      c(
        'chat',
        ['My mornings start with 20 apps.', 'Every morning at 06:30, read my inbox, calendar and yesterday’s revenue and send me a five-line briefing on Telegram.', 'Daily'],
        ['Mein Morgen fängt mit 20 Apps an.', 'Lies jeden Morgen um 6:30 Uhr mein Postfach, meinen Kalender und den Umsatz von gestern und schick mir ein Briefing in fünf Zeilen auf Telegram.', 'Täglich'],
      ),
      c(
        'browser',
        ['Booking travel is a maze.', 'Find the best flight to Lisbon next month that fits my calendar and a hotel near the venue under €180. Ask before you pay anything.', 'Once'],
        ['Reisen zu buchen ist ein Labyrinth.', 'Such den besten Flug nach Lissabon nächsten Monat, der in meinen Kalender passt, und ein Hotel in der Nähe vom Veranstaltungsort unter 180 €. Frag mich, bevor du etwas bezahlst.', 'Einmalig'],
      ),
      c(
        'browser',
        ['The appointment I need has no free slot.', 'Check the citizen office booking page for a free appointment in the next four weeks and book the first one that fits my calendar.', 'When a slot opens'],
        ['Für den Termin, den ich brauche, ist nichts frei.', 'Schau auf der Buchungsseite vom Bürgeramt nach einem freien Termin in den nächsten vier Wochen und buch den ersten, der in meinen Kalender passt.', 'Wenn ein Termin frei wird'],
      ),
      c(
        'browser',
        ['Cancelling a subscription is designed to be painful.', 'Cancel my streaming subscription that I haven’t used since June. Take screenshots of the confirmation.', 'Once'],
        ['Ein Abo zu kündigen ist absichtlich mühsam.', 'Kündige mein Streaming-Abo, das ich seit Juni nicht mehr genutzt habe. Mach Screenshots von der Bestätigung.', 'Einmalig'],
      ),
      c(
        'app',
        ['Family photos everywhere.', 'Find all photos from our trip to Italy on my Mac, put them in one album in Photos and share it with my partner.', 'Once'],
        ['Familienfotos sind überall verstreut.', 'Such alle Fotos von unserer Italienreise auf meinem Mac, pack sie in Fotos in ein Album und teil es mit meinem Partner.', 'Einmalig'],
      ),
      c(
        'browser',
        ['Bills and contracts I never compare.', 'Compare our electricity and internet contracts with current offers and tell me how much we’d save by switching. Don’t switch anything.', 'Yearly'],
        ['Rechnungen und Verträge, die ich nie vergleiche.', 'Vergleich unsere Strom- und Internetverträge mit aktuellen Angeboten und sag mir, wie viel wir mit einem Wechsel sparen würden. Wechsle nichts.', 'Jährlich'],
      ),
    ],
  },
];
