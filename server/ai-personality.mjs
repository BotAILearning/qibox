import { AppError } from './files.mjs';
import { personalityPresetStyle } from './ai-personality-catalog.mjs';
export { personalityPresets } from './ai-personality-catalog.mjs';
export function personalityStyle(id, selected) {
 const style=personalityPresetStyle(id,selected);
 if(!style)throw new AppError('性格或聊天风格选项无效，请重新选择');
 return style;
}

export function validatedPersonalityStyle(value) {
  const style=personalityStyle(value.personalityId,value.traits);
  if(value.summary!==undefined&&value.summary!==style.summary)throw new AppError('性格风格说明与选项不一致，草稿未保存，请重新选择或改为自定义风格');
  return style;
}
