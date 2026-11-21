/**
 * Bilingual strings. The host locale API does not carry pt-BR, so the language
 * is picked from the browser's own locale and falls back to English.
 */

export type Strings = {
  readonly settingsTitle: string
  readonly settingsShort: string
  readonly settingsDescription: string
  readonly enabledLabel: string
  readonly enabledHelp: string
  readonly attemptsLabel: string
  readonly attemptsHelp: string
  readonly delayLabel: string
  readonly delayHelp: string
  readonly truncatedLabel: string
  readonly truncatedHelp: string
  readonly announceLabel: string
  readonly announceHelp: string
  readonly blockLabel: string
  readonly blockHelp: string
  readonly blockPlaceholder: string
  readonly policyTitle: string
  readonly policyBody: string
  readonly logTitle: string
  readonly logHelp: string
  readonly logEmpty: string
  readonly runningVersion: (version: string) => string
  readonly declined: (reason: string) => string
  readonly skipped: (guard: string) => string
  readonly waiting: (seconds: number) => string
  readonly continuing: (attempt: number, max: number) => string
  readonly exhausted: (max: number) => string
  readonly failed: string
}

const EN: Strings = {
  settingsTitle: 'Auto-Continue',
  settingsShort: 'Continue',
  settingsDescription: 'Re-fire Continue when a reply dies from a dropped connection',
  enabledLabel: 'Auto-continue after a dropped connection',
  enabledHelp:
    'When a reply stops mid-stream because the connection to the provider broke, send Continue by itself so the message picks up where it stopped.',
  attemptsLabel: 'Maximum attempts per message',
  attemptsHelp: 'After this many automatic continues on the same reply, it stops and leaves the message to you. 1 to 10. A provider that stalls on a long prompt often clears on the third or fourth try, and an automatic attempt costs the same tokens as pressing Continue yourself.',
  delayLabel: 'Wait before continuing (seconds)',
  delayHelp: 'The pause doubles on each further attempt. Rate-limit failures always wait at least 20 seconds.',
  truncatedLabel: 'Also continue a reply cut off by the token limit',
  truncatedHelp:
    'No error happened: the model simply hit its output limit. Off by default, because a long reply can then grow on its own.',
  announceLabel: 'Announce what it is doing',
  announceHelp: 'Shows a short status line, readable by a screen reader, each time it waits, continues or declines.',
  blockLabel: 'Never continue when the error mentions',
  blockHelp: 'One word or phrase per line. Checked before every built-in rule.',
  blockPlaceholder: 'trial\nmy gateway',
  policyTitle: 'What it never retries',
  policyBody:
    'Payment, credit, quota and plan limits; invalid or missing API keys and every other credential failure; moderation and content policy; context length, unknown models and malformed requests; a generation you stopped yourself. An error it does not recognise is left alone too.',
  logTitle: 'Recent decisions',
  logHelp: 'Newest first. Every failure it could have continued leaves a line here, including the ones it chose not to continue.',
  logEmpty: 'Nothing recorded yet — no generation has failed since this page loaded.',
  runningVersion: (version) => `Running version ${version} in this page. The extension card can be newer until you reload.`,
  declined: (reason) => `Did not continue: ${reason}.`,
  skipped: (guard) => `Did not continue, guard: ${guard}.`,
  waiting: (seconds) => `Connection lost. Continuing in ${seconds}s...`,
  continuing: (attempt, max) => `Continuing the reply (attempt ${attempt} of ${max}).`,
  exhausted: (max) => `Stopped after ${max} automatic continues. Over to you.`,
  failed: 'The automatic continue could not start.',
}

const PT: Strings = {
  settingsTitle: 'Continuar automático',
  settingsShort: 'Continuar',
  settingsDescription: 'Manda Continue de novo quando a resposta morre por queda de conexão',
  enabledLabel: 'Continuar sozinho depois de queda de conexão',
  enabledHelp:
    'Quando a resposta para no meio porque a conexão com o provedor caiu, manda o Continue por conta própria para a mensagem seguir de onde parou.',
  attemptsLabel: 'Máximo de tentativas por mensagem',
  attemptsHelp: 'Depois dessa quantidade de continues automáticos na mesma resposta, ele desiste e deixa a mensagem para você. De 1 a 10. Provedor que engasga em prompt longo costuma destravar na terceira ou quarta tentativa, e a tentativa automática gasta os mesmos tokens que você gastaria apertando Continue na mão.',
  delayLabel: 'Esperar antes de continuar (segundos)',
  delayHelp: 'A pausa dobra em cada tentativa seguinte. Erro de limite de uso espera no mínimo 20 segundos.',
  truncatedLabel: 'Continuar também quando o limite de tokens cortar a resposta',
  truncatedHelp:
    'Não houve erro: o modelo só bateu no limite de saída. Desligado por padrão, porque assim uma resposta longa pode crescer sozinha.',
  announceLabel: 'Anunciar o que está fazendo',
  announceHelp: 'Mostra uma linha de status curta, lida por leitor de tela, cada vez que ele espera, continua ou recusa.',
  blockLabel: 'Nunca continuar quando o erro mencionar',
  blockHelp: 'Uma palavra ou frase por linha. Verificado antes de qualquer regra interna.',
  blockPlaceholder: 'teste\nmeu gateway',
  policyTitle: 'O que ele nunca repete',
  policyBody:
    'Pagamento, crédito, cota e limite de plano; chave de API inválida ou ausente e qualquer outra falha de credencial; moderação e política de conteúdo; tamanho de contexto, modelo desconhecido e requisição malformada; geração que você mesmo parou. Erro que ele não reconhece também fica quieto.',
  logTitle: 'Decisões recentes',
  logHelp: 'Mais recente primeiro. Toda falha que ele poderia ter continuado deixa uma linha aqui, inclusive as que ele escolheu não continuar.',
  logEmpty: 'Nada registrado ainda — nenhuma geração falhou desde que esta página carregou.',
  runningVersion: (version) => `Rodando a versão ${version} nesta página. O card da extensão pode estar mais novo até você recarregar.`,
  declined: (reason) => `Não continuei: ${reason}.`,
  skipped: (guard) => `Não continuei, trava: ${guard}.`,
  waiting: (seconds) => `Conexão caiu. Continuando em ${seconds}s...`,
  continuing: (attempt, max) => `Continuando a resposta (tentativa ${attempt} de ${max}).`,
  exhausted: (max) => `Parei depois de ${max} continues automáticos. A bola está com você.`,
  failed: 'O continue automático não conseguiu começar.',
}

export function pickStrings(): Strings {
  try {
    const languages = [navigator.language, ...(navigator.languages ?? [])]
    if (languages.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('pt'))) return PT
  } catch {
    /* no navigator (tests, odd embedders): fall through to English */
  }
  return EN
}
