const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const deploy=path.resolve(process.argv[2]||'packages/backend/deploy');
const req=require('module').createRequire(path.join(deploy,'package.json'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wing-docs-release-'));
process.env.SKYALYTICWING_DATA_DIR=root;
(async()=>{
  try {
    const {Document,Packer,Paragraph}=req('docx');
    const docx=path.join(root,'acceptance.docx');
    fs.writeFileSync(docx,await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Wing release document')]}]})));
    const XLSX=req('xlsx'),wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Plan','Credits'],['Starter',200]]),'Sheet1');
    const xlsx=path.join(root,'acceptance.xlsx');XLSX.writeFile(wb,xlsx);
    assert.equal(XLSX.readFile(xlsx).Sheets.Sheet1.B2.v,200);
    const PptxGenJS=req('pptxgenjs'),deck=new PptxGenJS();
    const slide=deck.addSlide();slide.addText('Wing release presentation',{x:1,y:1,w:8,h:1});
    const canvas=req('canvas').createCanvas(100,80);const ctx=canvas.getContext('2d');ctx.fillStyle='#65a3d5';ctx.fillRect(0,0,100,80);
    slide.addImage({data:canvas.toDataURL(),x:1,y:2,w:2,h:1.6});
    const pptx=path.join(root,'acceptance.pptx');await deck.writeFile({fileName:pptx});
    const {OfficeService}=req('./dist/modules/tools/files/office.service.js');
    const office=new OfficeService({isPathAllowed:p=>path.resolve(p).startsWith(root+path.sep)});
    for(const file of [docx,xlsx,pptx]){
      const snapshot=await office.read(file);
      assert.ok(snapshot.sections?.length>0, 'Document must have readable sections');
      assert.ok(snapshot.sections.some(s=>s.fields.length>0),'Document must have readable fields');
      console.log('PASS: create and read '+path.extname(file));
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
