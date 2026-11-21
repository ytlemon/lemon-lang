/**
 * class 测试：字段 + 方法 + self + 构造。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { errorCodes, runFiles } from './support';

const HEADER = '#incloud class\n';

/** 把一段 class 与 main 拼进完整的 __init__ 里 */
function program(body: string, header = HEADER): string {
  return `${header}\n__init__ {\n${body}\n}\n`;
}

const STUDENT = `    class Student {
        text name
        int age

        def name1(self) {
            return self.name + "1"
        }
    }`;

describe('class：定义与构造', () => {
  it('定义类 → 构造 → 读字段 → 调方法', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`    class Student {
        text name
        int age

        def name1(self) {
            return self.name + "1"
        }

        def name2(self) {
            return self.name + "2"
        }
    }

    main() {
        Student stu = Student("小明", 18)
        say(stu.name)
        say(stu.age)
        text a = stu.name1()
        text b = stu.name2()
        say(a + b)
    }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '小明\n18\n小明1小明2\n');
  });

  it('方法体里 self.字段 能读到值', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`    class Box {
        text label

        def show(self) {
            say(self.label)
        }
    }

    main() {
        Box b = Box("箱子")
        b.show()
    }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '箱子\n');
  });

  it('方法可以调用同类里的另一个方法（self.other()）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`    class A {
        text x

        def first(self) {
            return self.x
        }

        def second(self) {
            return self.first() + "!"
        }
    }

    main() {
        A a = A("hi")
        say(a.second())
    }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'hi!\n');
  });

  it('say(对象) 打印 类名(字段...)', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student("小明", 18)\n        say(s)\n    }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, 'Student(小明, 18)\n');
  });

  it('没有字段的类用 类名() 构造', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`    class Empty {
        def hi(self) {
            say("空类")
        }
    }

    main() {
        Empty e = Empty()
        e.hi()
    }`),
    });
    assert.equal(out.ok, true, JSON.stringify(out.diagnostics));
    assert.equal(out.stdout, '空类\n');
  });
});

describe('class：需要 #incloud class', () => {
  it('没启用模块时报 E0339', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() { say("hi") }`, ''),
    });
    assert.equal(out.ok, false);
    assert.deepEqual(errorCodes(out.diagnostics), ['E0339']);
    assert.match(out.diagnostics[0].message, /class 需要 class 能力模块/);
    assert.match(out.diagnostics[0].hint ?? '', /#incloud class/);
  });
});

describe('class：结构与类型校验', () => {
  it('类里写了别的语句：E0341', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    class A {\n        say(hi)\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0341']);
    assert.match(out.diagnostics[0].message, /只能写字段|却遇到/);
  });

  it('重复的类：E0306', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n${STUDENT}`),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0306'));
    assert.match(out.diagnostics[0].message, /重复声明/);
  });

  it('字段重名：E0306', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    class A {\n        text x\n        int x\n    }'),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0306'));
    assert.match(out.diagnostics[0].message, /字段 x 重复声明/);
  });

  it('用未定义的类当类型：E0342', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    main() {\n        Nope n = Nope()\n    }'),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0342'));
  });

  it('构造实参个数不对：E0310', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student("小明")\n    }`),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0310']);
    assert.match(out.diagnostics[0].message, /需要 2 个参数/);
  });

  it('构造实参类型不对：E0307', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student(18, 18)\n    }`),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0307']);
    assert.match(out.diagnostics[0].message, /字段 name 需要/);
  });

  it('读不存在的字段：E0317', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student("小明", 18)\n        say(s.nope)\n    }`),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0317'));
    assert.match(out.diagnostics[0].message, /没有字段 'nope'/);
  });

  it('调不存在的方法：E0317', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student("小明", 18)\n        s.nope()\n    }`),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0317'));
    assert.match(out.diagnostics[0].message, /没有方法 'nope'/);
  });

  it('方法实参个数不对：E0310', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`    class A {
        text x

        def greet(self, who) {
            return self.x + who
        }
    }

    main() {
        A a = A("hi")
        a.greet()
    }`),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0310']);
    assert.match(out.diagnostics[0].message, /需要 1 个参数/);
  });

  it('不能给对象字段赋值：E0338（对象只读）', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program(`${STUDENT}\n\n    main() {\n        Student s = Student("小明", 18)\n        s.name = "小红"\n    }`),
    });
    assert.ok(errorCodes(out.diagnostics).includes('E0338'));
  });

  it('class 不能写在函数体里：E0201', () => {
    const out = runFiles('app.lemon1', {
      'app.lemon1': program('    main() {\n        class A {\n            text x\n        }\n    }'),
    });
    assert.deepEqual(errorCodes(out.diagnostics), ['E0201']);
    assert.match(out.diagnostics[0].message, /只能写在 __init__ 顶层/);
  });
});
