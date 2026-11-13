import test from 'node:test';
import assert from 'node:assert/strict';
import { phonePlayLayout, type PhonePlayLayout, type PhonePlayPosition } from '../src/phonePlayLayout';

function overlaps(a: PhonePlayLayout, b: PhonePlayLayout): boolean {
  return a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
}

test('phone public plays fit the board and keep all four lanes separate, including 27-card plays', () => {
  for (const size of [{width:643,height:141},{width:716,height:177},{width:820,height:200},{width:366,height:500}]) {
    for (const seats of [3,4] as const) {
      const positions: PhonePlayPosition[] = seats===4 ? ['left','right','top','self'] : ['left','right','self'];
      for (const count of [0,1,3,6,12,seats===4?27:20]) {
        const layouts=positions.map(position=>phonePlayLayout(size,position,count,seats));
        layouts.forEach((layout,index)=>{
          assert.ok(layout.x >= 0 && layout.y >= 0, `${positions[index]} has a non-negative origin`);
          assert.ok(layout.x+layout.width <= size.width+.01);
          assert.ok(layout.y+layout.height <= size.height+.01);
          assert.ok(layout.rowStep>0 && layout.cardWidth>0);
          layouts.slice(index+1).forEach(other=>assert.equal(overlaps(layout,other),false));
        });
      }
    }
  }
});

test('own throw stays at the lower centre, right throw stays at the right edge and below the partner', () => {
  const size={width:643,height:141};
  const self=phonePlayLayout(size,'self',3,4), right=phonePlayLayout(size,'right',3,4), top=phonePlayLayout(size,'top',3,4);
  assert.equal(self.x+self.width/2,size.width/2);
  assert.ok(Math.abs(self.y+self.height-(size.height-6))<.01);
  assert.ok(right.x>size.width*.73);
  assert.ok(right.y>top.y);
  assert.ok(self.y>top.y+top.height);
});
