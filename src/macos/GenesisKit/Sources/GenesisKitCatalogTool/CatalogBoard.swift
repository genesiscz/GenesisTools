import Foundation

/// A portable board built from the same manifest as the rendered sheets. All catalog text enters
/// the document through textContent; the base64 payload cannot terminate a script element.
enum CatalogBoard {
    static func html(manifest: Data) -> String {
        let encoded = manifest.base64EncodedString()
        return #"""
        <!doctype html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>GenesisKit component catalog</title>
        <style>
        :root{color-scheme:dark;font:15px system-ui,sans-serif;background:#111315;color:#e8e9eb}
        *{box-sizing:border-box}body{margin:0}header{padding:32px 4vw 20px;border-bottom:1px solid #34373b}
        h1{font-size:30px;margin:0 0 8px}header p{color:#b4b9c1;max-width:75ch;line-height:1.5}
        nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;position:sticky;top:0;z-index:2;background:#181b1ff5;padding:14px 4vw;border-bottom:1px solid #34373b}
        label{display:flex;gap:8px;align-items:center}input,select{font:inherit;color:inherit;background:#24282d;border:1px solid #626b77;border-radius:6px;padding:8px}
        input{min-width:230px;flex:1}input:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #78bdff;outline-offset:3px}
        output{margin-left:auto;color:#b4b9c1}main{padding:0 4vw 60px}article{padding:30px 0;border-bottom:1px solid #34373b}
        h2{font-size:23px;margin:0 0 8px}h3{font-size:15px;margin:0 0 10px}.group{color:#8fc6fa;text-transform:uppercase;font-size:12px;letter-spacing:.09em}
        .summary{max-width:85ch;line-height:1.5}.source{color:#a0a8b4;font:12px ui-monospace,monospace;overflow-wrap:anywhere}
        .critique{color:#c1c7cf;line-height:1.6;max-width:85ch;padding-left:20px}.sheets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:22px}
        .sheets.single{grid-template-columns:minmax(0,1fr);max-width:1000px}figure{margin:0;min-width:0}figcaption{margin-bottom:8px}figcaption a{color:#a9d7ff;text-decoration:none}
        img{display:block;width:100%;height:auto;background:#1c1f23;border:1px solid #34373b;border-radius:6px}
        details{margin-top:18px;color:#b4b9c1}summary{cursor:pointer;padding:5px 0}.empty{padding:40px 0}
        @media(max-width:900px){.sheets{grid-template-columns:1fr}nav{position:static}header{padding-top:22px}output{width:100%;margin:0}}
        @media(prefers-reduced-motion:no-preference){a:hover{color:white}}
        </style>
        <header><h1>GenesisKit component catalog</h1><p>Real native controls, rendered from the current source. Compare the same states across the classic appearance and the three proposed looks. Open a sheet at full size to inspect its text and spacing.</p></header>
        <nav aria-label="Catalog filters">
        <label>Search <input id="query" type="search" placeholder="Component, purpose or source"></label>
        <label>Group <select id="group"><option value="">All groups</option></select></label>
        <label>Appearance <select id="look"><option value="">Compare all looks</option></select></label>
        <output id="count" aria-live="polite"></output></nav>
        <main id="catalog"></main>
        <script>
        const bytes=Uint8Array.from(atob("\#(encoded)"),c=>c.charCodeAt(0));
        const manifest=JSON.parse(new TextDecoder().decode(bytes));
        const query=document.querySelector('#query'),group=document.querySelector('#group'),look=document.querySelector('#look'),root=document.querySelector('#catalog');
        function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
        [...new Set(manifest.entries.map(e=>e.group))].sort().forEach(name=>{const option=el('option',name);option.value=name;group.append(option)});
        manifest.looks.forEach(item=>{const option=el('option',item.title);option.value=item.id;look.append(option)});
        const articles=manifest.entries.map(entry=>{
          const article=el('article');article.id=entry.id;article.append(el('p',entry.group,'group'),el('h2',entry.name),el('p',entry.summary,'summary'),el('p',entry.source,'source'));
          const critique=el('ul',undefined,'critique');entry.critique.forEach(text=>critique.append(el('li',text)));article.append(critique);
          const sheets=el('div',undefined,'sheets');entry.sheets.forEach(sheet=>{
            const figure=el('figure');figure.dataset.look=sheet.look;
            const caption=el('figcaption'),link=el('a',sheet.title);link.href=sheet.file;caption.append(link);figure.append(caption);
            if(sheet.note)figure.append(el('p',sheet.note));
            const image=el('img');image.src=sheet.file;image.alt=entry.name+' — '+sheet.title;image.width=sheet.pixelWidth;image.height=sheet.pixelHeight;image.loading='lazy';image.decoding='async';figure.append(image);sheets.append(figure);
          });article.append(sheets);
          const details=el('details');details.append(el('summary','States and variants'));entry.sections.forEach(section=>{details.append(el('h3',section.title));const list=el('ul');section.variants.forEach(variant=>list.append(el('li',variant.title+(variant.props?' · '+variant.props:''))));details.append(list)});article.append(details);root.append(article);
          return {entry,article,sheets,search:[entry.name,entry.group,entry.summary,entry.source,...entry.critique,...entry.sections.flatMap(s=>s.variants.map(v=>v.title))].join(' ').toLocaleLowerCase()};
        });
        const empty=el('p','No components match these filters.','empty');empty.hidden=true;root.append(empty);
        function filter(){const term=query.value.trim().toLocaleLowerCase();let count=0;articles.forEach(item=>{const visible=(!group.value||item.entry.group===group.value)&&(!term||item.search.includes(term));item.article.hidden=!visible;if(visible)count++;item.sheets.classList.toggle('single',Boolean(look.value));[...item.sheets.children].forEach(figure=>figure.hidden=Boolean(look.value)&&figure.dataset.look!==look.value)});document.querySelector('#count').textContent=count+' of '+articles.length+' components';empty.hidden=count!==0}
        query.addEventListener('input',filter);group.addEventListener('change',filter);look.addEventListener('change',filter);filter();
        </script></html>
        """#
    }
}
