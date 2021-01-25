use wasm_bindgen::prelude::*;
use swc_ecma_parser::{lexer::Lexer, Parser, Syntax, StringInput};
use swc_common::{BytePos, Span, Spanned};
use swc_ecma_visit::{noop_visit_type, Visit, VisitWith, Node};
use swc_ecma_ast::{ExprOrSuper, CallExpr, Lit, Str, Expr};
use std::convert::{TryInto};

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global
// allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

const TEST_ITEM_LEN: usize = 5;

const TEST_SUITE_NAME: &str = "suite";
const TEST_SUITE_NAME2: &str = "flakySuite";
const TEST_CASE_NAME: &str = "test";

struct TestItem([u32; TEST_ITEM_LEN]);

impl TestItem {
    fn new(depth: u32, test_span: &Span, name_span: &Span) -> TestItem {
        TestItem([
            depth,
            test_span.lo().0, (test_span.hi() - test_span.lo()).0,
            name_span.lo().0, (name_span.hi() - name_span.lo()).0
        ])
    }
}

struct TestDiscovery {
    pub tests: Vec<TestItem>,
    depth: u32
}

impl TestDiscovery {
    fn new() -> TestDiscovery {
        TestDiscovery { depth: 0, tests: Vec::new() }
    }

    fn results(&self) -> Vec<u32> {
        let mut output: Vec<u32> = Vec::with_capacity(TEST_ITEM_LEN * self.tests.len());
        for test in &self.tests {
            output.extend_from_slice(&test.0);
        }

        output
    }
}

impl Visit for TestDiscovery {
    noop_visit_type!();

    fn visit_call_expr(&mut self, expr: &CallExpr, _parent: &dyn Node) {
        let method_call = match &expr.callee {
            ExprOrSuper::Expr(call_expr) => match &**call_expr {
                Expr::Ident(ident) => &ident.sym,
                _ => return,
            },
            _ => return
        };

        if method_call == TEST_CASE_NAME {
            match get_suite_or_test_name(&expr) {
                Some(name) => self.tests.push(TestItem::new(self.depth, &expr.span(), &name.span())),
                None => {}
            };
        } else if method_call == TEST_SUITE_NAME || method_call == TEST_SUITE_NAME2 {
            match get_suite_or_test_name(&expr) {
                Some(name) => {
                    self.tests.push(TestItem::new(self.depth, &expr.span(), &name.span()));
                    self.depth += 1;
                    expr.visit_children_with(self);
                    self.depth -= 1;
                }
                None => {}
            }
        }
    }
}

fn get_suite_or_test_name(expr: &CallExpr) -> Option<&Str> {
    if expr.args.len() < 2 {
        return None
    }

    match &*expr.args[0].expr {
        Expr::Lit(lit) => match lit {
            Lit::Str(str) => Some(str),
            _ => None
        },
        _ => None
    }
}

#[wasm_bindgen]
pub fn extract(src: &str) -> Vec<u32> {
    let lexer = Lexer::new(
        Syntax::Typescript(Default::default()),
        Default::default(),
        StringInput::new(&src, BytePos(0), BytePos(src.len().try_into().unwrap())),
        None,
    );

    let module = match Parser::new_from(lexer).parse_typescript_module() {
        Ok(r) => r,
        _ => return Vec::new()
    };

    let mut discover = TestDiscovery::new();
    module.visit_children_with(&mut discover);
    discover.results()
}


#[cfg(test)]
mod tests {
    // Note this useful idiom: importing names from outer (for mod tests) scope.
    use super::*;

    #[test]
    fn test_extracts_empty() {
        assert_eq!(extract(""), vec![]);
    }

    #[test]
    fn test_extracts_test() {
        assert_eq!(extract("test('hello', () => {})"), vec![0, 0, 23, 5, 7]);
    }

    #[test]
    fn test_extracts_single_deep() {
        assert_eq!(extract("suite('asdf', () => {
            test('hello', () => {})
        })"), vec![
            0, 0, 68, 6, 6,
            1, 34, 23, 39, 7,
        ]);
    }
}
