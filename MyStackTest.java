public class MyStackTest {
	public static void main(String [] args) {
		MyStack<Integer> stack = new MyStack<Integer>();
		stack.push(0);
		stack.push(30);
		stack.push(2);
		System.out.println(stack.pop());
		System.out.println(stack.pop());
		System.out.println(stack.pop());
	}
}