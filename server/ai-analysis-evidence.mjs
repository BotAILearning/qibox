// Explicit, machine-verifiable claims only; no provider call or retry.
export function analysisEvidenceViolation(report, messages) {
  const text=String(report||'').normalize('NFKC');
  for(const line of text.split('\n')) {
    const sequence=/^\s*(?:[-*]\s*)?sequence\s+(\d+)[,，]\s*(本人|你|对方|未知)[,，]\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/iu.exec(line);
    if(sequence) {
      const source=messages.find(m=>m.sequence===Number(sequence[1]));
      if(!source||source.speaker!==(sequence[2]==='你'?'本人':sequence[2])||source.beijingTime!==sequence[3])return 'sequence';
    }
    for(const sentence of line.split(/[。！？!?]/u)) {
      if(/[“”"「」]|^(?:如果|假如|例如|比如)/u.test(sentence.trim()))continue;
      const owner=/([A-Za-z][A-Za-z0-9_-]{3,})\s*(?:标识|消息|发言)[^,，;；]{0,12}(?:均|都|全部)(?:落在|来自|由|是)?\s*(本人|你|对方)/u.exec(sentence);
      if(owner){
        const sources=messages.filter(m=>m.text.includes(owner[1]));
        if(!sources.length||sources.some(m=>m.speaker!==(owner[2]==='你'?'本人':owner[2])))return 'marker-owner';
      }
      const all=/共\s*(\d+)\s*条(?:可读)?消息[^。！？!?\n]{0,80}(?:均|都|全部)带(?:有)?\s*([A-Za-z][A-Za-z0-9_-]{3,})/u.exec(sentence);
      if(all&&Number(all[1])===messages.length&&messages.some(m=>!m.text.includes(all[2])))return 'marker-coverage';
    }
  }
  return '';
}
