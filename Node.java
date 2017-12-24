public class Node <T> {
	public Node next;
	public T data;

	public Node(T data) {
		this.data = data;
		this.next = null;
	}

	public String toString() {
		return "[Data: " + this.data.toString() + "] -> ";
	}

}