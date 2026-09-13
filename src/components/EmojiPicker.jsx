import React, { useEffect, useRef, useState } from 'react';

// Compact built-in set (name keywords for search). Rendered with the system's colour emoji font.
const GROUPS = {
  Smileys: '😀 grinning|😃 smile happy|😄 laugh|😁 grin|😆 laughing|😅 sweat smile|🤣 rofl|😂 joy tears|🙂 slight smile|😉 wink|😊 blush|😇 halo angel|🥰 love hearts|😍 heart eyes|🤩 star struck|😘 kiss|😋 yum|😛 tongue|🤪 zany|🤔 thinking|🤨 raised eyebrow|😐 neutral|😶 no mouth|🙄 eye roll|😏 smirk|😬 grimace|😌 relieved|😔 pensive|😴 sleeping|🤒 sick|🤕 hurt|🤢 nauseated|🥵 hot|🥶 cold|😵 dizzy|🤯 mind blown|🥳 party|😎 cool sunglasses|🤓 nerd|😕 confused|😟 worried|🙁 frown|😮 open mouth|😲 astonished|😳 flushed|🥺 pleading|😢 cry|😭 sob|😱 scream|😤 huff|😡 angry|🤬 swearing|💀 skull|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot',
  People: '👍 thumbs up|👎 thumbs down|👌 ok|✌️ peace|🤞 fingers crossed|🤟 love you|🤘 rock|👋 wave hello|🤚 raised hand|🖐️ hand|✋ stop|🤙 call me|💪 muscle strong|🙏 pray thanks please|👏 clap|🙌 raised hands|🤝 handshake|✍️ writing|👀 eyes|🧠 brain|👶 baby|🧑 person|👩 woman|👨 man|🧓 older|👮 police|👷 builder|🧑‍💻 developer coder|🧑‍🔧 mechanic|🧑‍🍳 chef|🧑‍⚕️ doctor|🧑‍🏫 teacher|🕵️ detective|🦸 hero|🧙 wizard|💃 dance|🏃 run|🚶 walk|🧘 yoga',
  Animals: '🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦅 eagle|🦉 owl|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee|🐛 bug|🦋 butterfly|🐌 snail|🐢 turtle|🐍 snake|🐙 octopus|🦀 crab|🐟 fish|🐬 dolphin|🐳 whale|🦈 shark|🐊 crocodile|🐘 elephant|🦒 giraffe|🌵 cactus|🌲 tree|🌸 blossom|🌹 rose|🌻 sunflower|🍀 clover luck|🌍 earth globe|🌙 moon|⭐ star|🌈 rainbow|☀️ sun|⛅ cloud|🌧️ rain|⛈️ storm|❄️ snow|🔥 fire',
  Food: '🍎 apple|🍌 banana|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🍍 pineapple|🥝 kiwi|🍅 tomato|🥑 avocado|🥕 carrot|🌽 corn|🍞 bread|🥐 croissant|🧀 cheese|🍔 burger|🍟 fries|🍕 pizza|🌭 hot dog|🌮 taco|🍣 sushi|🍜 noodles|🍝 pasta|🍛 curry|🥗 salad|🍿 popcorn|🍩 donut|🍪 cookie|🎂 birthday cake|🍰 cake|🍫 chocolate|🍬 candy|☕ coffee|🍵 tea|🥤 drink|🍺 beer|🍷 wine|🥂 cheers champagne|🍾 champagne',
  Activities: '⚽ football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🏉 rugby|🎱 pool|🏓 ping pong|🏸 badminton|🥊 boxing|⛳ golf|🎣 fishing|🎽 running|🎿 ski|🏂 snowboard|🏆 trophy win|🥇 gold medal|🎖️ medal|🎯 target bullseye|🎮 gaming controller|🎲 dice|🧩 puzzle|🎨 art palette|🎬 movie clapper|🎤 microphone|🎧 headphones|🎵 music note|🎶 notes|🎸 guitar|🎹 piano|🥁 drum|🎺 trumpet|🎻 violin|🎭 theatre|🎪 circus|🎟️ ticket|🎁 gift present|🎈 balloon|🎉 party popper tada|🎊 confetti|🎄 christmas tree|🎃 halloween pumpkin',
  Travel: '🚗 car|🚕 taxi|🚌 bus|🚎 trolley|🏎️ race car|🚓 police car|🚑 ambulance|🚒 fire engine|🚐 van|🚚 truck delivery|🚜 tractor|🏍️ motorbike|🚲 bicycle|🛴 scooter|🚀 rocket|✈️ plane|🛫 departure|🛬 arrival|🚁 helicopter|⛵ sailboat|🚢 ship|🚂 train|🚆 rail|🚇 metro|🚉 station|🏠 house|🏢 office|🏭 factory|🏥 hospital|🏦 bank|🏨 hotel|🏫 school|⛪ church|🗼 tower|🗽 liberty|🏰 castle|🏖️ beach|🏝️ island|🏔️ mountain|🗺️ map|🧭 compass|🧳 luggage',
  Objects: '⌚ watch|📱 phone|💻 laptop|🖥️ desktop computer|🖨️ printer|⌨️ keyboard|🖱️ mouse|💾 floppy save|💿 disc|📀 dvd|📷 camera|📹 video camera|🎥 film|📺 tv|📻 radio|🔋 battery|🔌 plug|💡 bulb idea|🔦 torch|🕯️ candle|💰 money bag|💵 dollar|💷 pound|💶 euro|💳 credit card|🧾 receipt|✉️ envelope email|📧 e-mail|📨 incoming|📩 envelope arrow|📤 outbox|📥 inbox|📦 package parcel box|📫 mailbox|📮 postbox|✏️ pencil|🖊️ pen|📝 memo note|📁 folder|📂 open folder|📅 calendar date|📆 calendar|📌 pin|📎 paperclip|🔗 link|📏 ruler|🔒 lock|🔓 unlock|🔑 key|🔨 hammer|🔧 wrench|🔩 bolt|⚙️ gear|🧰 toolbox|🧲 magnet|💊 pill|🩹 bandage|🧹 broom|🧺 basket|🛒 cart shopping|🛍️ bags shopping|🎓 graduation',
  Symbols: '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💖 sparkling heart|💯 hundred|✅ check tick done|❌ cross no|❓ question|❗ exclamation|⚠️ warning|🚫 prohibited|♻️ recycle|✔️ check mark|➕ plus|➖ minus|✖️ multiply|➗ divide|💲 dollar|©️ copyright|®️ registered|™️ trademark|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|⚫ black circle|⚪ white circle|⬆️ up|⬇️ down|⬅️ left|➡️ right|🔄 refresh|⏰ alarm clock|⏳ hourglass|⌛ hourglass done|📣 megaphone|🔔 bell|🔕 mute|💤 zzz sleep|💬 speech|💭 thought|🆕 new|🆗 ok|🆙 up|🔜 soon|🔝 top|🏁 finish flag|🏳️ white flag|🇬🇧 uk flag|🇺🇸 us flag|🇪🇺 eu flag',
};
const ALL = Object.entries(GROUPS).flatMap(([g, s]) => s.split('|').map(x => { const i = x.indexOf(' '); return { g, e: x.slice(0, i), k: x.slice(i + 1) }; }));
const RECENT_KEY = 'tomail_recent_emoji';

export default function EmojiPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState(() => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } });
  const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; document.addEventListener('mousedown', h); document.addEventListener('keydown', k, true); return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); }; }, [onClose]);
  const pick = (e) => { const r = [e, ...recent.filter(x => x !== e)].slice(0, 24); setRecent(r); try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch {} onPick(e); };
  const ql = q.trim().toLowerCase();
  const list = ql ? ALL.filter(x => x.k.includes(ql)) : null;
  return (
    <div className="emoji menu" ref={ref} onMouseDown={e => e.preventDefault()}>
      <div className="mform"><input type="text" placeholder="Search emoji…" value={q} onChange={e => setQ(e.target.value)} autoFocus /></div>
      <div className="egrid-wrap">
        {list ? <div className="egrid">{list.map(x => <button key={x.e} title={x.k} onClick={() => pick(x.e)}>{x.e}</button>)}{!list.length && <span className="muted" style={{ padding: 8 }}>No match</span>}</div> : <>
          {recent.length > 0 && <><div className="mhead">Recent</div><div className="egrid">{recent.map(e => <button key={e} onClick={() => pick(e)}>{e}</button>)}</div></>}
          {Object.keys(GROUPS).map(g => <React.Fragment key={g}><div className="mhead">{g}</div><div className="egrid">{ALL.filter(x => x.g === g).map(x => <button key={x.e} title={x.k} onClick={() => pick(x.e)}>{x.e}</button>)}</div></React.Fragment>)}
        </>}
      </div>
    </div>
  );
}
