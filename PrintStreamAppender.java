import java.io.*;

public class PrintStreamAppender implements Appender {

	private PrintStream printer;
	
	public PrintStreamAppender(PrintStream p) {
		printer = p;
	}

	public void append(String s) {
		printer.println(s);
	}
}