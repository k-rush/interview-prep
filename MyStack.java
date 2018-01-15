import java.util.*;
public class MyStack<T> {
	private static class StackNode<T> {
		private T data;
		private StackNode<T> next;
		public StackNode(T data) {
			this.data = data;
		}
	}

	private StackNode<T> top;

	public T pop() {
		if(top == null) throw new EmptyStackException();
		T popped = top.data;
		top = top.next;
		return popped;
	}

	public void push(T item) {
		StackNode<T> newTop = new StackNode<T>(item);
		newTop.next = top;
		top = newTop;
	}

	public T peek() {
		if(top == null) throw new EmptyStackException();
		return top.data;
	}

	public boolean isEmpty() {
		return (top == null);
	}
}