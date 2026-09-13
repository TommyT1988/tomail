import React, { useEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker.jsx';
import Icon from './Icons.jsx';

const ALLOWED = /^(B|I|U|STRONG|EM|P|DIV|BR|UL|OL|LI|A|BLOCKQUOTE|IMG|SPAN|H[1-6]|PRE|CODE|TABLE|TBODY|TR|TD|TH|HR|S|STRIKE|FONT|SUP|SUB)$/;
/** Strip scripts/handlers and unknown tags from pasted HTML. */
export function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.test(el.tagName)) { const frag = document.createDocumentFragment(); while (el.firstChild) frag.appendChild(el.firstChild); el.replaceWith(frag); continue; }
      for (const a of [...el.attributes]) { if (/^on/i.test(a.name) || (a.name === 'href' && /^\s*javascript:/i.test(a.value)) || (a.name === 'src' && !/^(data:image|https?:|cid:)/i.test(a.value))) el.removeAttribute(a.name); }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/** contenteditable editor. value = html; onChange(html). Uncontrolled after mount so the caret is never disturbed. */
export default function RichEditor({ value, onChange, placeholder = 'Write your message…', autoFocus }) {
  const ref = useRef(null);
  const last = useRef(value);
  const [emoji, setEmoji] = useState(false);
  const savedRange = useRef(null);
  const saveRange = () => { const s = window.getSelection(); if (s && s.rangeCount && ref.current?.contains(s.anchorNode)) savedRange.current = s.getRangeAt(0).cloneRange(); };
  const insertEmoji = (e) => { ref.current.focus(); const s = window.getSelection(); if (savedRange.current) { s.removeAllRanges(); s.addRange(savedRange.current); } document.execCommand('insertText', false, e); emit(); saveRange(); };
  useEffect(() => { if (ref.current && value !== last.current && value !== ref.current.innerHTML) { ref.current.innerHTML = value || ''; last.current = value; } }, [value]);
  useEffect(() => { if (ref.current) { ref.current.innerHTML = value || ''; last.current = value; if (autoFocus) { ref.current.focus(); placeCaretAtStart(ref.current); } } }, []); // eslint-disable-line
  const emit = () => { const h = ref.current.innerHTML; last.current = h; onChange(h); };
  const cmd = (c, v) => { ref.current.focus(); document.execCommand(c, false, v); emit(); };
  const link = () => { const u = prompt('Link URL:', 'https://'); if (u) cmd('createLink', u); };
  const image = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cmd('insertImage', r.result); r.readAsDataURL(f); };
    inp.click();
  };
  const onPaste = (e) => {
    const html = e.clipboardData.getData('text/html');
    if (html) { e.preventDefault(); document.execCommand('insertHTML', false, cleanHtml(html)); emit(); return; }
    const file = [...e.clipboardData.files || []].find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); const r = new FileReader(); r.onload = () => cmd('insertImage', r.result); r.readAsDataURL(file); }
  };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey) { const k = e.key.toLowerCase(); if (k === 'b') { e.preventDefault(); cmd('bold'); } if (k === 'i') { e.preventDefault(); cmd('italic'); } if (k === 'u') { e.preventDefault(); cmd('underline'); } if (k === 'k') { e.preventDefault(); link(); } }
  };
  const B = ({ c, v, title, children, onClick }) => <button type="button" title={title} onMouseDown={e => e.preventDefault()} onClick={onClick || (() => cmd(c, v))}>{children}</button>;
  return (
    <div className="rich">
      <div className="tb">
        <B c="bold" title="Bold (Ctrl+B)"><b>B</b></B><B c="italic" title="Italic (Ctrl+I)"><i>I</i></B><B c="underline" title="Underline (Ctrl+U)"><u>U</u></B><B c="strikeThrough" title="Strikethrough"><s>S</s></B>
        <span className="sp" />
        <B c="insertUnorderedList" title="Bulleted list">• List</B><B c="insertOrderedList" title="Numbered list">1. List</B><B c="formatBlock" v="blockquote" title="Quote">❝</B>
        <span className="sp" />
        <B title="Link (Ctrl+K)" onClick={link}><Icon name="external" size={12} /> Link</B><B title="Insert image" onClick={image}><Icon name="image" size={12} /> Image</B>
        <span className="sp" />
        <B c="removeFormat" title="Clear formatting">Tx</B>
        <span className="sp" />
        <span style={{ position: 'relative' }}><B title="Emoji" onClick={() => { saveRange(); setEmoji(v => !v); }}>😊</B>{emoji && <EmojiPicker onPick={insertEmoji} onClose={() => setEmoji(false)} />}</span>
      </div>
      <div className="ed" ref={ref} contentEditable suppressContentEditableWarning data-placeholder={placeholder} onInput={emit} onBlur={() => { saveRange(); emit(); }} onKeyUp={saveRange} onMouseUp={saveRange} onPaste={onPaste} onKeyDown={onKey} spellCheck />
    </div>
  );
}
function placeCaretAtStart(el) { const r = document.createRange(); r.setStart(el, 0); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
