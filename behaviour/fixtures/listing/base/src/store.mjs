// The office's tasks. A task's trigger says how it starts: by hand (manual), on an event (a new e-mail, a new
// document) or on a schedule. An event or schedule task runs by itself only while automaticEnabled is on.
const TITLES = [
  'Responder ao cliente Ferreira', 'Rever contrato de arrendamento', 'Enviar fatura de outubro', 'Arquivar emails antigos',
  'Preparar reunião de equipa', 'Atualizar lista de clientes', 'Confirmar prazo no tribunal', 'Pedir certidão predial',
  'Resumo semanal da caixa', 'Lembrete de pagamento IVA', 'Classificar documentos novos', 'Ligar ao notário',
  'Rever proposta da Silva Lda', 'Backup dos ficheiros', 'Agendar visita ao cliente', 'Corrigir morada na ficha',
  'Enviar relatório mensal', 'Validar horas da equipa', 'Responder à Ordem', 'Fechar processo 2024/118',
];
const TRIGGERS = { 3: ['schedule', true], 8: ['schedule', true], 9: ['schedule', false], 10: ['event', true], 13: ['schedule', true] };

export const TASKS = TITLES.map((title, i) => {
  const [type, automaticEnabled] = TRIGGERS[i] ?? ['manual', false];
  return {
    id: `t${String(i + 1).padStart(3, '0')}`,
    title,
    status: i % 4 === 0 ? 'done' : 'open',
    column: ['a fazer', 'em curso', 'à espera', 'feito'][i % 4],
    due: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
    trigger: { type, automaticEnabled },
    notes: '',
  };
});
