import test from 'node:test';
import assert from 'node:assert/strict';
import { tabletSeatLayout } from '../src/tabletSeatLayout';
import { bottomLayout, passLayout } from '../src/tableLayout';

test('complete tablet placards fit each edge at tablet and compact landscape sizes', () => {
  for (const size of [{w:1366,h:900},{w:1024,h:600},{w:744,h:800},{w:620,h:340},{w:544,h:260}]) {
    const seats = [{x:.5,y:.88},{x:.9,y:.5},{x:.5,y:.12},{x:.1,y:.5}];
    const boxes = seats.map(seat => tabletSeatLayout(seat,size));
    for (const box of boxes) {
      const x=box.left/100*size.w, y=box.top/100*size.h;
      assert.ok(x-box.width/2>=11.99 && x+box.width/2<=size.w-11.99);
      assert.ok(y-box.height/2>=11.99 && y+box.height/2<=size.h-11.99);
      assert.ok(box.scale>=.72 && box.scale<=1);
    }
    boxes.forEach((a,index) => boxes.slice(index+1).forEach(b => {
      const dx=Math.abs(a.left-b.left)/100*size.w, dy=Math.abs(a.top-b.top)/100*size.h;
      assert.ok(dx>=(a.width+b.width)/2 || dy>=(a.height+b.height)/2, `placards must not overlap at ${JSON.stringify(size)}`);
    }));
    assert.deepEqual(boxes.map(box=>box.angle),[0,-90,180,90]);
  }
});

test('large rotated pass marks avoid placards and the actual Guandan centre instead of a fictitious bottom block', () => {
  for (const size of [{w:976,h:588},{w:720,h:774}]) {
    const seats=[{x:.5,y:.88},{x:.9,y:.5},{x:.5,y:.12},{x:.1,y:.5}];
    const placards=seats.map(seat=>{
      const box=tabletSeatLayout(seat,size);
      return {cx:box.left/100*size.w,cy:box.top/100*size.h,width:box.width,height:box.height,angle:0};
    });
    const centre={cx:size.w/2,cy:size.h*.5,width:217,height:190,angle:0};
    for (const block of [null,bottomLayout(size,0)]) {
      for (const seat of seats) {
        const point=passLayout(seat,size,block,[...placards,...(block?[]:[centre])],{w:104,h:78});
        const rotated=Math.abs(point.angle)===90;
        const halfX=(rotated?78:104)/2,halfY=(rotated?104:78)/2;
        const cx=point.left/100*size.w,cy=point.top/100*size.h;
        assert.ok(cx-halfX>=0 && cx+halfX<=size.w);
        assert.ok(cy-halfY>=0 && cy+halfY<=size.h);
        for (const other of placards) {
          assert.ok(Math.abs(cx-other.cx)>=halfX+other.width/2-.1 || Math.abs(cy-other.cy)>=halfY+other.height/2-.1);
        }
      }
    }
  }
});
